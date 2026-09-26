import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { Context, Deferred, Effect, Layer, Option, Schema } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as Authentication from "../src/Authentication.js";
import { httpClient, mcpCall, serve } from "./serve.js";
import { rawToolCall } from "./requests.js";

class Identity extends Context.Service<Identity, { readonly id: string }>()("test/Identity") {}

class Tokens extends Context.Service<Tokens, { readonly prefix: string }>()("test/Tokens") {}

class Private extends Schema.TaggedError<Private>()("Private", { message: Schema.String }) {}

const request = (token?: string) =>
  new Request("http://localhost/identity", {
    headers: token === undefined ? {} : { authorization: token },
  });

/** Authenticate the token as the identity, refusing a missing token and `denied`. */
const authenticateToken = Effect.gen(function* () {
  const token = (yield* HttpServerRequest.HttpServerRequest).headers.authorization;

  if (token === undefined) {
    return yield* new Action.Unauthenticated({ message: "Missing token" });
  }

  if (token === "denied") return yield* new Action.Forbidden({ message: "Denied token" });

  return { id: token };
});

describe("Authentication.middleware", () => {
  it("answers a refusal as its JSON: a 401 with a Bearer challenge, or a 403 without one", async () => {
    let calls = 0;

    const auth = Authentication.middleware(Identity, authenticateToken);

    const web = serve(
      HttpRouter.add(
        "GET",
        "/identity",
        Effect.gen(function* () {
          calls++;

          return HttpServerResponse.text((yield* Identity).id);
        }),
      ).pipe(Layer.provide(auth.layer)),
    );

    onTestFinished(() => web.dispose());

    // The body is the error's own JSON encoding, the one a typed client decodes.
    for (const [token, status, challenge, body] of [
      [
        undefined,
        401,
        "Bearer",
        Schema.encodeSync(Action.Unauthenticated)(
          new Action.Unauthenticated({ message: "Missing token" }),
        ),
      ],
      [
        "denied",
        403,
        null,
        Schema.encodeSync(Action.Forbidden)(new Action.Forbidden({ message: "Denied token" })),
      ],
    ] as const) {
      const response = await web.handler(request(token));
      expect(response.status).toBe(status);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("www-authenticate")).toBe(challenge);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual(body);
    }

    expect(calls).toBe(0);
    expect(await (await web.handler(request("alice"))).text()).toBe("alice");
    expect(await (await web.handler(request("bob"))).text()).toBe("bob");
    expect(calls).toBe(2);
  });

  it("answers a default refusal with its default message", async () => {
    const auth = Authentication.middleware(Identity, Effect.fail(new Action.Unauthenticated()));

    const web = serve(
      HttpRouter.add("GET", "/identity", HttpServerResponse.text("unreachable")).pipe(
        Layer.provide(auth.layer),
      ),
    );

    onTestFinished(() => web.dispose());

    const response = await web.handler(request());
    expect(response.status).toBe(401);
    // The constructor's default message, `Authentication is required.`, on the wire.
    expect(await response.json()).toEqual(
      Schema.encodeSync(Action.Unauthenticated)(new Action.Unauthenticated()),
    );
  });

  it("sends the host's own response instead, with its status and headers", async () => {
    const auth = Authentication.middleware(
      Identity,
      Effect.gen(function* () {
        const token = (yield* HttpServerRequest.HttpServerRequest).headers.authorization;

        if (token === undefined) {
          return yield* Effect.fail(
            HttpServerResponse.text("Sign in first", {
              status: 401,
              headers: { "www-authenticate": 'Bearer realm="host"' },
            }),
          );
        }

        return { id: token };
      }),
    );

    const web = serve(
      HttpRouter.add(
        "GET",
        "/identity",
        Effect.map(Identity, ({ id }) => HttpServerResponse.text(id)),
      ).pipe(Layer.provide(auth.layer)),
    );

    onTestFinished(() => web.dispose());

    const response = await web.handler(request());
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="host"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("Sign in first");
    expect(await (await web.handler(request("alice"))).text()).toBe("alice");
  });

  it("challenges only its own refusals, leaving every other 401 as it is", async () => {
    const auth = Authentication.middleware(
      Identity,
      Effect.gen(function* () {
        const token = (yield* HttpServerRequest.HttpServerRequest).headers.authorization;

        return token === undefined
          ? yield* Effect.fail(HttpServerResponse.text("Sign in first", { status: 401 }))
          : { id: token };
      }),
    );

    const web = serve(
      HttpRouter.add(
        "GET",
        "/identity",
        Effect.succeed(HttpServerResponse.text("Not this one", { status: 401 })),
      ).pipe(Layer.provide(auth.layer)),
    );

    onTestFinished(() => web.dispose());

    // The host's own response, and a route's own 401 behind the middleware.
    for (const response of [await web.handler(request()), await web.handler(request("alice"))]) {
      expect(response.status).toBe(401);
      expect(response.headers.has("www-authenticate")).toBe(false);
    }
  });

  it("rejects any other failure in the types, and answers it with an empty 500", async () => {
    const auth = Authentication.middleware(
      Identity,
      // @ts-expect-error Only a refusal or a response may fail authentication; plain JavaScript can still fail with anything.
      Effect.fail(new Private({ message: "Undeclared" })),
    );

    const web = serve(
      HttpRouter.add("GET", "/identity", HttpServerResponse.text("unreachable")).pipe(
        Layer.provide(auth.layer),
      ),
    );

    onTestFinished(() => web.dispose());

    const response = await web.handler(request());
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
  });

  it("delivers its refusals to the typed client and to MCP callers", async () => {
    const Identify = Action.make("identify", {
      description: "Read the authenticated identity",
      access: "read",
      success: Schema.String,
    });

    const app = Action.implement(Identify, () => Effect.map(Identity, ({ id }) => id));
    const Http = ActionHttp.make([Identify]);

    const web = serve(
      Layer.mergeAll(
        ActionHttp.layer(Http, app),
        ActionMcp.layerHttp(app, { name: "refusal-test", version: "0" }),
      ).pipe(Layer.provide(Authentication.middleware(Identity, authenticateToken).layer)),
    );

    onTestFinished(() => web.dispose());

    const failureOf = (token?: string) =>
      Effect.runPromise(
        Effect.flip(
          Effect.flatMap(
            httpClient(Http, web, {
              transformClient: HttpClient.mapRequest((request) =>
                token === undefined
                  ? request
                  : HttpClientRequest.setHeader(request, "authorization", token),
              ),
            }),
            (client) => client.identify(),
          ),
        ),
      );

    const missing = await failureOf();
    expect(missing).toBeInstanceOf(Action.Unauthenticated);
    expect(missing).toMatchObject({ message: "Missing token" });
    const denied = await failureOf("denied");
    expect(denied).toBeInstanceOf(Action.Forbidden);
    expect(denied).toMatchObject({ message: "Denied token" });

    // The MCP endpoint is refused before any tool runs: the HTTP 401 itself.
    await expect(mcpCall(web, { name: "identify" })).rejects.toThrow(
      /answered 401: .*"Missing token"/,
    );
    expect(await mcpCall(web, { name: "identify", headers: { authorization: "alice" } })).toEqual({
      isError: false,
      value: "alice",
    });
  });

  it("keeps resources acquired by authentication alive for the handler and releases on handler failure", async () => {
    const events: string[] = [];

    const auth = Authentication.middleware(
      Identity,
      Effect.acquireRelease(
        Effect.sync(() => {
          events.push("acquire");

          return { id: "alice" };
        }),
        () =>
          Effect.sync(() => {
            events.push("release");
          }),
      ),
    );

    const web = serve(
      HttpRouter.add(
        "GET",
        "/identity",
        Effect.gen(function* () {
          expect((yield* Identity).id).toBe("alice");
          expect(events).toEqual(["acquire"]);
          events.push("handler");

          return yield* Effect.die(new Error("handler failed"));
        }),
      ).pipe(Layer.provide(auth.layer)),
    );

    onTestFinished(() => web.dispose());
    const response = await web.handler(request());
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(events).toEqual(["acquire", "handler", "release"]);
  });

  it("protects private errors serialized by enclosing middleware", async () => {
    const auth = Authentication.middleware(Identity, Effect.succeed({ id: "alice" }));

    const outer = HttpRouter.middleware<{ handles: Private }>()((effect) =>
      Effect.catch(effect, (error) =>
        Schema.is(Private)(error)
          ? Effect.succeed(
              HttpServerResponse.text(error.message, {
                status: 404,
                headers: { "cache-control": "public, max-age=60" },
              }),
            )
          : Effect.fail(error),
      ),
    );

    const web = serve(
      HttpRouter.add(
        "GET",
        "/identity",
        Effect.gen(function* () {
          const identity = yield* Identity;

          return yield* new Private({ message: `private data for ${identity.id}` });
        }),
      ).pipe(Layer.provide(auth.combine(outer).layer)),
    );

    onTestFinished(() => web.dispose());
    const response = await web.handler(request());
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("private data for alice");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("tracks and resolves authentication dependencies using native middleware composition", async () => {
    const auth = Authentication.middleware(
      Identity,
      Effect.gen(function* () {
        const tokens = yield* Tokens;
        const incoming = yield* HttpServerRequest.HttpServerRequest;

        return { id: `${tokens.prefix}${incoming.headers.authorization}` };
      }),
    );

    // Native middleware requires composition before its layer becomes available.
    const missing: string = auth.layer;
    void missing;

    const tokens = HttpRouter.middleware<{ provides: Tokens }>()((effect) =>
      Effect.provideService(effect, Tokens, { prefix: "actor:" }),
    );

    const web = serve(
      HttpRouter.add(
        "GET",
        "/identity",
        Effect.map(Identity, (actor) => HttpServerResponse.text(actor.id)),
      ).pipe(Layer.provide(auth.combine(tokens).layer)),
    );

    onTestFinished(() => web.dispose());
    expect(await (await web.handler(request("alice"))).text()).toBe("actor:alice");
  });

  it.each(["http", "mcp"] as const)(
    "closes asynchronous authentication resources after a successful %s response",
    async (transport) => {
      const events: string[] = [];
      const releasing = Effect.runSync(Deferred.make<void>());
      const allowRelease = Effect.runSync(Deferred.make<void>());
      const released = Effect.runSync(Deferred.make<void>());

      const auth = Authentication.middleware(
        Identity,
        Effect.acquireRelease(
          Effect.sync(() => {
            events.push("acquire");

            return { id: "alice" };
          }),
          () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(releasing, undefined);
              yield* Deferred.await(allowRelease);
              events.push("release");
              yield* Deferred.succeed(released, undefined);
            }),
        ),
      );

      const Identify = Action.make("identify", {
        description: "Read the identity while its authentication resource is alive",
        access: "write",
        success: Schema.String,
      });

      const app = Action.implement(Identify, () =>
        Effect.gen(function* () {
          expect(events).toEqual(["acquire"]);
          events.push("handler");

          return (yield* Identity).id;
        }),
      );

      const routes =
        transport === "http"
          ? ActionHttp.layer(ActionHttp.make([Identify]), app)
          : ActionMcp.layerHttp(app, { name: "scope-test", version: "0" });

      const web = serve(routes.pipe(Layer.provide(auth.layer)));

      onTestFinished(async () => {
        await Effect.runPromise(Deferred.succeed(allowRelease, undefined));
        await web.dispose();
      });

      const response = await web.handler(
        transport === "http"
          ? new Request("http://localhost/api/identify", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
            })
          : rawToolCall("identify"),
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("alice");
      // Web handlers resolve the Response before asynchronous request finalizers
      // finish; streaming responses begin cleanup when their body is consumed.
      await Effect.runPromise(Deferred.await(releasing));
      expect(events).toEqual(["acquire", "handler"]);
      await Effect.runPromise(Deferred.succeed(allowRelease, undefined));
      await Effect.runPromise(Deferred.await(released));
      expect(events).toEqual(["acquire", "handler", "release"]);
    },
  );
});

describe("Authentication.bearerToken", () => {
  const tokenOf = (authorization?: string) =>
    Effect.runSync(
      Effect.provideService(
        Authentication.bearerToken,
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request("http://localhost/", {
            headers: authorization === undefined ? {} : { authorization },
          }),
        ),
      ),
    );

  it("reads the token of a Bearer authorization, whatever the scheme's case", () => {
    expect(tokenOf("Bearer alice")).toEqual(Option.some("alice"));
    expect(tokenOf("bearer alice")).toEqual(Option.some("alice"));
    expect(tokenOf("BEARER alice")).toEqual(Option.some("alice"));
  });

  it("is absent without an authorization, with another scheme, or without a token", () => {
    expect(tokenOf()).toEqual(Option.none());
    expect(tokenOf("Basic YWxpY2U6c2VjcmV0")).toEqual(Option.none());
    expect(tokenOf("Bearer")).toEqual(Option.none());
    expect(tokenOf("Bearer ")).toEqual(Option.none());
    expect(tokenOf("Bearer two tokens")).toEqual(Option.none());
  });
});
