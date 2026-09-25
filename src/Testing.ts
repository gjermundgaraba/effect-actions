import { Effect, Layer, Option, Predicate, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import * as ActionHttpClient from "./ActionHttpClient.js";
import { type AnyHttp, type Client, withFetch } from "./internal/client.js";
import { type McpEndpoint, mcpRequest, type McpRequestValue } from "./internal/mcp-request.js";

/** A web handler, such as `HttpRouter.toWebHandler(routes).handler`. */
export type Handler = (request: Request) => Promise<Response>;

/** Served routes in memory: their web handler, and how to release them. */
export interface Server {
  readonly handler: Handler;
  /** Release the routes' resources. Register it with the test runner's cleanup hook. */
  readonly dispose: () => Promise<void>;
}

/** What `serve` provides or leaves to routes: the router, the platform, nothing per request. */
type Served =
  | HttpRouter.HttpRouter
  | HttpRouter.Request<"Requires", never>
  | HttpRouter.Request<"GlobalRequires", never>
  | HttpRouter.Request<"Error", any>
  | HttpRouter.Request<"GlobalError", any>
  | Layer.Success<typeof HttpServer.layerServices>;

/**
 * Serve `routes` in memory, without a network or request logs, providing the platform
 * services `HttpServer.layerServices` provides. Routes must satisfy their per-request
 * requirements themselves, with their middleware.
 */
export function serve<A, E, R extends Served>(routes: Layer.Layer<A, E, R>): Server;
export function serve(routes: Layer.Layer<unknown, unknown, Served>): Server {
  const web = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
  });

  return { handler: (request) => web.handler(request), dispose: web.dispose };
}

/** A served `Server` or its bare web handler. */
const handlerOf = (target: Server | Handler): Handler =>
  Predicate.isFunction(target) ? target : target.handler;

/**
 * `ActionHttpClient.make` for the binding, calling `server` in memory instead of the
 * network. `baseUrl` defaults to `http://localhost`.
 */
export const httpClient = <const H extends AnyHttp>(
  http: H,
  server: Server | Handler,
  options?: ActionHttpClient.Options,
): Effect.Effect<Client<H>> =>
  ActionHttpClient.make(http, { baseUrl: "http://localhost", ...options }).pipe(
    withFetch((input, init) => handlerOf(server)(new Request(input, init))),
  );

/** One `tools/call` for `mcpCall`: the endpoint, the tool and its arguments. */
interface McpCallOptions extends McpEndpoint {
  /** The tool name: its action's name. */
  readonly name: string;
  /** Defaults to `{}`. It may be malformed on purpose. */
  readonly arguments?: { readonly [key: string]: McpRequestValue };
  readonly headers?: ConstructorParameters<typeof Headers>[0];
}

/**
 * A tool call's outcome with the library's wire envelope removed: the success from
 * `structuredContent.value`, or the error text of an `isError` result, parsed as JSON
 * when it is JSON (a declared error, whatever its shape) and kept as the text otherwise
 * (the native server's own message, such as for invalid arguments).
 */
export type McpCallResult =
  | { readonly isError: false; readonly value: Schema.Json }
  | { readonly isError: true; readonly error: Schema.Json };

/** The JSON-RPC response to a `tools/call`: a tool result or a protocol error. */
const ToolReply = Schema.Union([
  Schema.Struct({
    result: Schema.Struct({
      isError: Schema.optionalKey(Schema.Boolean),
      structuredContent: Schema.optionalKey(Schema.Struct({ value: Schema.Json })),
      content: Schema.Array(
        Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }),
      ),
    }),
  }),
  Schema.Struct({ error: Schema.Struct({ code: Schema.Finite, message: Schema.String }) }),
]);

const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(ToolReply));

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/**
 * Call one tool through `server` with a stateless 2026-07-28 request and return its
 * outcome. A response that is not an HTTP 200 carrying a tool result, such as an
 * authentication refusal or a JSON-RPC error, throws with its status and body.
 */
export const mcpCall = async (
  server: Server | Handler,
  { name, headers, arguments: args = {}, ...endpoint }: McpCallOptions,
): Promise<McpCallResult> => {
  const response = await handlerOf(server)(
    mcpRequest({
      ...endpoint,
      method: "tools/call",
      params: { name, arguments: args },
      ...(headers === undefined ? {} : { headers }),
    }),
  );

  const body = await response.text();

  if (response.status !== 200) {
    throw new Error(`MCP tools/call "${name}" answered ${response.status}: ${body}`);
  }

  // A JSON body is one message; an event stream carries one per `data:` line, and
  // notifications may precede the reply.
  const reply = body
    .split("\n")
    .map((line) => line.replace(/^data:/, "").trim())
    .flatMap((line) => Option.toArray(decodeReply(line)))
    .at(-1);

  if (reply === undefined) throw new Error(`MCP tools/call "${name}" had no reply: ${body}`);

  if ("error" in reply) {
    throw new Error(
      `MCP tools/call "${name}" failed with ${reply.error.code}: ${reply.error.message}`,
    );
  }

  const { result } = reply;

  if (result.isError === true) {
    const text = result.content.find((content) => content.type === "text")?.text ?? "";

    return { isError: true, error: Option.getOrElse(parseJson(text), () => text) };
  }

  if (result.structuredContent === undefined) {
    throw new Error(`MCP tools/call "${name}" returned no structured content: ${body}`);
  }

  return { isError: false, value: result.structuredContent.value };
};
