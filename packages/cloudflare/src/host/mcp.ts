import { DurableObject } from "cloudflare:workers";
import { Context, Layer, ManagedRuntime } from "effect";
import type { Scope } from "effect";
import { HttpEffect, HttpRouter, HttpServer } from "effect/http";
import type { HttpServerRequest } from "effect/http";

import type * as ActionWorker from "./ActionWorker.js";

const sessionHeader = "mcp-session-id";

/** The endpoint's layer, built from an object's `env`, as `ActionWorker.Mcp`'s `layer` gives it. */
export type EndpointOf<Env> = (
  env: Env
) => Layer.Layer<
  never,
  unknown,
  | ActionWorker.Cluster
  | HttpRouter.HttpRouter
  | Layer.Success<typeof HttpServer.layerServices>
>;

const objectIdOf = (namespace: DurableObjectNamespace, hex: string) => {
  try {
    return namespace.idFromString(hex);
  } catch {
    return undefined;
  }
};

const withSession = (response: Response, session: string) => {
  const headers = new Headers(response.headers);

  headers.set(sessionHeader, session);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

/**
 * The Worker's side of the MCP endpoint: a request naming a session goes to the object its
 * `Mcp-Session-Id` names before its first `.`, carrying the server's own id after it; any other
 * goes to this isolate's own object, made once with `newUniqueId`, and a session it opens is named
 * to the client with that object's id before the server's.
 */
export const forwarding = () => {
  let own: DurableObjectId | undefined;

  return async (
    request: Request,
    namespace: DurableObjectNamespace
  ): Promise<Response> => {
    const sent = request.headers.get(sessionHeader);

    if (sent === null) {
      own ??= namespace.newUniqueId();

      const id = own;
      const response = await namespace.get(id).fetch(request);
      const opened = response.headers.get(sessionHeader);

      return opened === null
        ? response
        : withSession(response, `${id.toString()}.${opened}`);
    }

    const dot = sent.indexOf(".");
    const id = dot > 0 ? objectIdOf(namespace, sent.slice(0, dot)) : undefined;

    if (id === undefined) {
      return new Response(null, { status: 404 });
    }

    const headers = new Headers(request.headers);

    headers.set(sessionHeader, sent.slice(dot + 1));

    return await namespace.get(id).fetch(new Request(request, { headers }));
  };
};

/**
 * The Durable Object class serving the MCP endpoint, one server per object, built as the object
 * starts, before it takes a request, over the isolate's application less its router, which is
 * merged into the endpoint's, so each request runs with the isolate's services as a route's does.
 * A build that fails rejects in `blockConcurrencyWhile`, which resets the object, so its next
 * request builds again.
 */
export const endpointClass = <Env>(
  context: (
    env: Env
  ) => Promise<Context.Context<ActionWorker.Cluster | HttpRouter.HttpRouter>>,
  layerOf: EndpointOf<Env>
): new (ctx: DurableObjectState, env: Env) => DurableObject<Env> =>
  class McpEndpoint extends DurableObject<Env> {
    #handler!: (request: Request) => Promise<Response>;

    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env);

      void ctx.blockConcurrencyWhile(async () => {
        const isolate = Context.omit(HttpRouter.HttpRouter)(await context(env));

        const built = await ManagedRuntime.make(
          layerOf(env).pipe(
            Layer.provide(HttpServer.layerServices),
            Layer.provideMerge(Layer.succeedContext(isolate)),
            Layer.provideMerge(HttpRouter.layer)
          )
        ).context();

        this.#handler = HttpEffect.toWebHandlerWith<
          HttpRouter.HttpRouter,
          HttpServerRequest.HttpServerRequest | Scope.Scope
        >(built)(Context.get(built, HttpRouter.HttpRouter).asHttpEffect());
      });
    }

    override async fetch(request: Request): Promise<Response> {
      return await this.#handler(request);
    }
  };
