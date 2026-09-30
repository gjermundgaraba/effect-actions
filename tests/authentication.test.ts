import { inspect } from "node:util";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { Context, Deferred, Effect, Layer, Option, Redacted, Schema, Stream } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import * as Authentication from "../src/Authentication.js";
import * as Testing from "../src/Testing.js";
import { authenticate as tenantAuthentication } from "../examples/authentication-tenant.js";
import { Http as ExampleHttp } from "../examples/binding.js";
import { WhoAmI as ExampleWhoAmI } from "../examples/contracts.js";
import { userActions } from "../examples/handlers.js";
import { Users } from "../examples/users.js";
import { against, httpClient, serve } from "./serve.js";
import { mcpRequest, post, rawToolCall } from "./requests.js";
import type { Equal } from "./equal.js";

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

describe("Authentication.make", () => {
  it("answers a refusal as its JSON: a 401 with a Bearer challenge, or a 403 without one", async () => {
    let calls = 0;

    const auth = Authentication.make(Identity, Effect.succeed(authenticateToken));

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
    const auth = Authentication.make(
      Identity,
      Effect.succeed(Effect.fail(new Action.Unauthenticated())),
    );

    const web = serve(
      HttpRouter.add("GET", "/identity", HttpServerResponse.text("unreachable")).pipe(
        Layer.provide(auth.layer),
      ),
    );

    const response = await web.handler(request());
    expect(response.status).toBe(401);
    // The constructor's default message, `Authentication is required.`, on the wire.
    expect(await response.json()).toEqual(
      Schema.encodeSync(Action.Unauthenticated)(new Action.Unauthenticated()),
    );
  });

  it("sends the host's own response instead, with its status and headers", async () => {
    const auth = Authentication.make(
      Identity,
      Effect.succeed(
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
      ),
    );

    const web = serve(
      HttpRouter.add(
        "GET",
        "/identity",
        Effect.map(Identity, ({ id }) => HttpServerResponse.text(id)),
      ).pipe(Layer.provide(auth.layer)),
    );

    const response = await web.handler(request());
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="host"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("Sign in first");
    expect(await (await web.handler(request("alice"))).text()).toBe("alice");
  });

  it("challenges every 401 it covers that has no challenge of its own", async () => {
    const auth = Authentication.make(
      Identity,
      Effect.succeed(
        Effect.gen(function* () {
          const token = (yield* HttpServerRequest.HttpServerRequest).headers.authorization;

          return token === undefined
            ? yield* Effect.fail(HttpServerResponse.text("Sign in first", { status: 401 }))
            : { id: token };
        }),
      ),
    );

    const web = serve(
      HttpRouter.add(
        "GET",
        "/identity",
        Effect.succeed(HttpServerResponse.text("Not this one", { status: 401 })),
      ).pipe(Layer.provide(auth.layer)),
    );

    // The host's own response, and a route's own 401 behind the middleware, whose request
    // presented a bearer token that did not authenticate it.
    const host = await web.handler(request());
    const route = await web.handler(request("Bearer alice"));

    expect([host.status, route.status]).toEqual([401, 401]);
    expect(host.headers.get("www-authenticate")).toBe("Bearer");
    expect(route.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
  });

  it("names the scopes a first login requests in every 401 of a protected resource", async () => {
    const Read = Action.make("read", { description: "Read", access: "read" });

    const resource = {
      resource: "https://api.example.com/api",
      authorizationServers: ["https://auth.example.com"],
      scopesSupported: ["docs:read", "docs:write"],
      scopesRequired: ["docs:read"],
    } as const;

    const challenge =
      'Bearer scope="docs:read", resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/api"';

    const web = serve(
      ActionHttp.layer(
        ActionHttp.make([Read]),
        Action.implement(
          Read,
          () => Effect.void,
          () => Effect.fail(new Action.Unauthenticated()),
        ),
      ).pipe(
        Layer.provide(
          Authentication.make(
            Identity,
            Effect.succeed(
              Effect.map(Authentication.bearerToken, (token) => ({ id: Redacted.value(token) })),
            ),
            resource,
          ).layer,
        ),
      ),
    );

    // A missing token, and a hook's refusal of an authenticated caller.
    const missing = await web.handler(post("/api/read"));

    const hooked = await web.handler(
      new Request("http://localhost/api/read", {
        method: "POST",
        headers: { authorization: "Bearer alice", "content-type": "application/json" },
        body: "{}",
      }),
    );

    expect([missing.status, hooked.status]).toEqual([401, 401]);
    expect(missing.headers.get("www-authenticate")).toBe(challenge);
    expect(hooked.headers.get("www-authenticate")).toBe(
      challenge.replace("Bearer ", 'Bearer error="invalid_token", '),
    );
  });

  it("challenges a refusal naming scopes with insufficient_scope, its own or a hook's", async () => {
    const Write = Action.make("write", { description: "Write", access: "write" });

    const app = Action.implement(
      Write,
      () => Effect.void,
      () =>
        Effect.fail(new Action.Forbidden({ message: 'Needs "write".', scopes: ["a:write", "b"] })),
    );

    const resource = {
      resource: "https://api.example.com/api",
      authorizationServers: ["https://auth.example.com"],
    } as const;

    const metadata = "https://api.example.com/.well-known/oauth-protected-resource/api";

    const web = serve(
      Layer.mergeAll(
        ActionHttp.layer(ActionHttp.make([Write]), app).pipe(
          Layer.provide(
            Authentication.make(
              Identity,
              Effect.succeed(Effect.succeed({ id: "caller" })),
              resource,
            ).layer,
          ),
        ),
        HttpRouter.add("GET", "/scoped", HttpServerResponse.text("never")).pipe(
          Layer.provide(
            Authentication.make(
              Identity,
              Effect.succeed(
                Effect.fail(new Action.Forbidden({ message: "Read only.", scopes: ["read"] })),
              ),
              resource,
            ).layer,
          ),
        ),
      ),
    );

    // A hook's refusal. Its message is no RFC 6750 error description, so it has none.
    const hooked = await web.handler(post("/api/write"));
    expect(hooked.status).toBe(403);
    expect(hooked.headers.get("www-authenticate")).toBe(
      `Bearer error="insufficient_scope", scope="a:write b", resource_metadata="${metadata}"`,
    );
    expect(await hooked.json()).toEqual(
      Schema.encodeSync(Action.Forbidden)(
        new Action.Forbidden({ message: 'Needs "write".', scopes: ["a:write", "b"] }),
      ),
    );

    // Authentication's own.
    const own = await web.handler(new Request("http://localhost/scoped"));
    expect(own.status).toBe(403);
    expect(own.headers.get("www-authenticate")).toBe(
      `Bearer error="insufficient_scope", scope="read", resource_metadata="${metadata}", error_description="Read only."`,
    );
  });

  it("challenges a hook's scopes under authentication only, naming no metadata without a resource", async () => {
    const Write = Action.make("write", { description: "Write", access: "write" });

    const refusing = (error: Action.Forbidden) =>
      Action.implement(
        Write,
        () => Effect.void,
        () => Effect.fail(error),
      );

    const authenticated = (error: Action.Forbidden) =>
      serve(
        ActionHttp.layer(ActionHttp.make([Write]), refusing(error)).pipe(
          Layer.provide(
            Authentication.make(Identity, Effect.succeed(Effect.succeed({ id: "alice" }))).layer,
          ),
        ),
      );

    const refused = await authenticated(new Action.Forbidden({ scopes: ["write"] })).handler(
      post("/api/write"),
    );

    expect(refused.status).toBe(403);
    expect(refused.headers.get("www-authenticate")).toBe(
      'Bearer error="insufficient_scope", scope="write", error_description="Not allowed."',
    );

    // A refusal naming no scope has no challenge: re-authorizing would not help.
    const plain = await authenticated(new Action.Forbidden()).handler(post("/api/write"));
    expect(plain.headers.get("www-authenticate")).toBeNull();

    // Without authentication there is no OAuth client to step up: a declared error, as it is.
    const open = serve(
      ActionHttp.layer(
        ActionHttp.make([Write]),
        refusing(new Action.Forbidden({ scopes: ["write"] })),
      ),
    );

    const answered = await open.handler(post("/api/write"));
    expect(answered.status).toBe(403);
    expect(answered.headers.get("www-authenticate")).toBeNull();
  });

  it("refuses a scope that is no OAuth scope token", () => {
    expect(new Action.Forbidden({ scopes: ["users:write"] }).scopes).toEqual(["users:write"]);
    expect(() => new Action.Forbidden({ scopes: ["has space"] })).toThrow();
  });

  it("rejects any other failure in the types, and answers it with an empty 500", async () => {
    const auth = Authentication.make(
      Identity,
      // @ts-expect-error Only a refusal or a response may fail authentication; plain JavaScript can still fail with anything.
      Effect.succeed(Effect.fail(new Private({ message: "Undeclared" }))),
    );

    const web = serve(
      HttpRouter.add("GET", "/identity", HttpServerResponse.text("unreachable")).pipe(
        Layer.provide(auth.layer),
      ),
    );

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

    // Provided around both surfaces, the authentication covers each of their routes.
    const web = serve(
      Layer.mergeAll(
        ActionHttp.layer(Http, app),
        ActionMcp.layerHttp(app, { name: "refusal-test", version: "0" }),
      ).pipe(Layer.provide(Authentication.make(Identity, Effect.succeed(authenticateToken)).layer)),
    );

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

    // The MCP endpoint is refused before any tool runs, with the HTTP 401 itself, which
    // decodes as the same refusal.
    const identify = (options?: Testing.McpClientOptions) =>
      Effect.flatMap(Testing.mcpClient([Identify], options), (mcp) => mcp.identify());

    expect(await against(web, Effect.flip(identify()))).toEqual(
      new Action.Unauthenticated({ message: "Missing token" }),
    );
    expect(
      await against(
        web,
        identify({
          transformClient: HttpClient.mapRequest(
            HttpClientRequest.setHeader("authorization", "alice"),
          ),
        }),
      ),
    ).toBe("alice");
  });

  it("keeps resources acquired by authentication alive for the handler and releases on handler failure", async () => {
    const events: string[] = [];

    const auth = Authentication.make(
      Identity,
      Effect.succeed(
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

    const response = await web.handler(request());
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(events).toEqual(["acquire", "handler", "release"]);
  });

  it("protects private errors serialized by enclosing middleware", async () => {
    const auth = Authentication.make(Identity, Effect.succeed(Effect.succeed({ id: "alice" })));

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
      ).pipe(Layer.provide(auth.layer), Layer.provide(outer.layer)),
    );

    const response = await web.handler(request());
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("private data for alice");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps the caching a route states, and no-stores every other response", async () => {
    const auth = Authentication.make(Identity, Effect.succeed(Effect.succeed({ id: "alice" })));

    const web = serve(
      Layer.mergeAll(
        HttpRouter.add(
          "GET",
          "/artifact",
          HttpServerResponse.text("artifact", {
            headers: { "cache-control": "private, max-age=31536000, immutable" },
          }),
        ),
        HttpRouter.add("GET", "/identity", HttpServerResponse.text("alice")),
      ).pipe(Layer.provide(auth.layer)),
    );

    const artifact = await web.handler(new Request("http://localhost/artifact"));
    expect(artifact.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect((await web.handler(request())).headers.get("cache-control")).toBe("no-store");
  });

  it("builds the services its build yields once, as startup requirements of its layer", async () => {
    let built = 0;

    // Built like a handler builder: `Tokens` once, at startup; the request per request.
    const auth = Authentication.make(
      Identity,
      Effect.gen(function* () {
        const tokens = yield* Tokens;

        return Effect.map(HttpServerRequest.HttpServerRequest, (incoming) => ({
          id: `${tokens.prefix}${incoming.headers.authorization}`,
        }));
      }),
    );

    // A startup requirement of the layer, not of each request; the request is the router's.
    const owesTokens: Equal<
      Layer.Services<typeof auth.layer>,
      HttpRouter.HttpRouter | Tokens
    > = true;

    void owesTokens;

    const tokens = Layer.effect(
      Tokens,
      Effect.sync(() => {
        built += 1;

        return { prefix: "actor:" };
      }),
    );

    const web = serve(
      HttpRouter.add(
        "GET",
        "/identity",
        Effect.map(Identity, (actor) => HttpServerResponse.text(actor.id)),
      ).pipe(Layer.provide(auth.layer.pipe(Layer.provide(tokens)))),
    );

    expect(await (await web.handler(request("alice"))).text()).toBe("actor:alice");
    expect(await (await web.handler(request("bob"))).text()).toBe("actor:bob");
    expect(built).toBe(1);
  });

  it.each(["http", "mcp"] as const)(
    "closes asynchronous authentication resources after a successful %s response",
    async (transport) => {
      const events: string[] = [];
      const releasing = Effect.runSync(Deferred.make<void>());
      const allowRelease = Effect.runSync(Deferred.make<void>());
      const released = Effect.runSync(Deferred.make<void>());

      const auth = Authentication.make(
        Identity,
        Effect.succeed(
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

      const web = serve(
        transport === "http"
          ? ActionHttp.layer(ActionHttp.make([Identify]), app).pipe(Layer.provide(auth.layer))
          : ActionMcp.layerHttp(app, { name: "scope-test", version: "0" }).pipe(
              Layer.provide(auth.layer),
            ),
      );

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

describe("Authentication.make's refusals", () => {
  const resource = {
    resource: "https://api.example.com/mcp",
    authorizationServers: ["https://auth.example.com"],
    scopesRequired: ["read"],
  } as const;

  const metadata = "https://api.example.com/.well-known/oauth-protected-resource/mcp";

  const web = (error: Action.Refusal) =>
    serve(
      HttpRouter.add("GET", "/identity", HttpServerResponse.text("never")).pipe(
        Layer.provide(
          Authentication.make(Identity, Effect.succeed(Effect.fail(error)), resource).layer,
        ),
      ),
    );

  it.each([
    [new Action.Unauthenticated(), 401, `Bearer scope="read", resource_metadata="${metadata}"`],
    [
      new Action.Forbidden({ scopes: ["write"] }),
      403,
      `Bearer error="insufficient_scope", scope="write", resource_metadata="${metadata}", error_description="Not allowed."`,
    ],
    [new Action.Forbidden(), 403, null],
  ] as const)(
    "answers %s with its JSON, status and challenge, never cached",
    async (error, status, challenge) => {
      const response = await web(error).handler(request());

      expect(response.status).toBe(status);
      expect(response.headers.get("www-authenticate")).toBe(challenge);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual(
        Schema.encodeSync(Schema.Union([Action.Unauthenticated, Action.Forbidden]))(error),
      );
    },
  );

  it.each([
    ["Bearer x", `Bearer error="invalid_token", scope="read", resource_metadata="${metadata}"`],
    // Another scheme, or no token, presented no bearer token: RFC 6750 names no error code.
    ["Basic YWxpY2U6c2VjcmV0", `Bearer scope="read", resource_metadata="${metadata}"`],
    ["Bearer", `Bearer scope="read", resource_metadata="${metadata}"`],
  ])(
    "names invalid_token only for a bearer token presented: %s",
    async (authorization, challenge) => {
      const response = await web(new Action.Unauthenticated()).handler(
        new Request("http://localhost/identity", { headers: { authorization } }),
      );

      expect(response.headers.get("www-authenticate")).toBe(challenge);
    },
  );

  it("refuses a required scope that is no OAuth scope token", () => {
    const bad = { ...resource, scopesRequired: ["has space"] as const };

    expect(() =>
      Authentication.make(Identity, Effect.succeed(Effect.succeed({ id: "a" })), bad),
    ).toThrow('Invalid scope in scopesRequired: "has space"');
  });

  it("leaves a request whose URL does not parse to the host, not a 500", async () => {
    const response = await web(new Action.Unauthenticated()).handler(
      new Request("http://localhost//[x/y"),
    );

    expect(response.status).toBe(404);
  });
});

describe("Authentication.bearerToken", () => {
  const withAuthorization = (authorization?: string) =>
    Effect.provideService(
      Authentication.bearerToken,
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(
        new Request("http://localhost/", {
          headers: authorization === undefined ? {} : { authorization },
        }),
      ),
    );

  const tokenOf = (authorization?: string) =>
    Option.map(Effect.runSync(Effect.option(withAuthorization(authorization))), Redacted.value);

  it("reads the token of a Bearer authorization, whatever the scheme's case", () => {
    expect(tokenOf("Bearer alice")).toEqual(Option.some("alice"));
    expect(tokenOf("bearer alice")).toEqual(Option.some("alice"));
    expect(tokenOf("BEARER alice")).toEqual(Option.some("alice"));
  });

  it("keeps the token out of anything that prints it", () => {
    const token = Effect.runSync(withAuthorization("Bearer alice"));

    expect(inspect(token)).not.toContain("alice");
    expect(JSON.stringify({ token })).not.toContain("alice");
  });

  it("fails without an authorization, with another scheme, or without a token", () => {
    expect(tokenOf()).toEqual(Option.none());
    expect(tokenOf("Basic YWxpY2U6c2VjcmV0")).toEqual(Option.none());
    expect(tokenOf("Bearer")).toEqual(Option.none());
    expect(tokenOf("Bearer ")).toEqual(Option.none());
    expect(tokenOf("Bearer two tokens")).toEqual(Option.none());
  });

  it("fails with the built-in 401, so authentication needs no branch of its own", () => {
    expect(Effect.runSync(Effect.flip(withAuthorization()))).toEqual(
      new Action.Unauthenticated({ message: "A bearer token is required." }),
    );
  });
});

describe("authentication around a surface", () => {
  const Public = Action.make("public", {
    description: "Answer anyone",
    access: "read",
    success: Schema.String,
  });

  const Secret = Action.make("secret", {
    description: "Answer the authenticated identity",
    access: "read",
    input: { note: Schema.String },
    success: Schema.String,
  });

  const Http = ActionHttp.make([Public, Secret]);
  const authenticate = Authentication.make(Identity, Effect.succeed(authenticateToken)).layer;

  const open = Action.implement(Public, () => Effect.succeed("anyone"));

  const guarded = Action.implement(Secret, ({ note }) =>
    Effect.map(Identity, ({ id }) => `${id}: ${note}`),
  );

  const call = (path: string, body: Schema.Json, token?: string) => {
    const request = post(`/api/${path}`, body);

    if (token !== undefined) request.headers.set("authorization", token);

    return request;
  };

  it("builds its services once, on every HTTP surface it covers", async () => {
    let built = 0;

    const verify = Authentication.make(
      Identity,
      Effect.gen(function* () {
        const { prefix } = yield* Tokens;

        return Effect.map(Authentication.bearerToken, (token) => ({
          id: `${prefix}${Redacted.value(token)}`,
        }));
      }),
    );

    // What its build yields is a startup requirement of the layers it covers.
    const tokens = Layer.effect(
      Tokens,
      Effect.sync(() => {
        built++;

        return { prefix: "actor:" };
      }),
    );

    const routes = Layer.mergeAll(
      ActionHttp.layer(Http, guarded),
      ActionMcp.layerHttp(guarded, { name: "test", version: "0" }),
    ).pipe(Layer.provide(verify.layer.pipe(Layer.provide(tokens))));

    const web = serve(routes);

    const response = await web.handler(call("secret", { note: "hi" }, "Bearer alice"));
    expect(await response.json()).toBe("actor:alice: hi");

    const called = Effect.flatMap(
      Testing.mcpClient([Secret], {
        transformClient: HttpClient.mapRequest(
          HttpClientRequest.setHeader("authorization", "Bearer alice"),
        ),
      }),
      (mcp) => mcp.secret({ note: "hi" }),
    );

    expect(await against(web, called)).toBe("actor:alice: hi");
    expect(built).toBe(1);
  });

  it("may be any native middleware providing the identity, a combined one included", async () => {
    class Tenant extends Context.Service<Tenant, string>()("test/Tenant") {}

    // The identity needs the tenant another middleware resolves for the request.
    const identify = HttpRouter.middleware<{ provides: Identity }>()((effect) =>
      Effect.flatMap(Tenant, (tenant) => Effect.provideService(effect, Identity, { id: tenant })),
    );

    const resolveTenant = HttpRouter.middleware<{ provides: Tenant }>()((effect) =>
      Effect.provideService(effect, Tenant, "acme"),
    );

    const tenanted = Action.implement(Secret, ({ note }) =>
      Effect.flatMap(Tenant, (tenant) =>
        Effect.map(Identity, ({ id }) => `${id}@${tenant}: ${note}`),
      ),
    );

    // Everything the combined middleware provides is provided, so nothing is owed.
    const web = serve(
      Layer.mergeAll(
        ActionHttp.layer(Http, tenanted),
        ActionMcp.layerHttp(tenanted, { name: "test", version: "0" }),
      ).pipe(Layer.provide(identify.combine(resolveTenant).layer)),
    );

    expect(await (await web.handler(call("secret", { note: "hi" }))).json()).toBe("acme@acme: hi");
    const called = Effect.flatMap(Testing.mcpClient([Secret]), (mcp) => mcp.secret({ note: "hi" }));

    expect(await against(web, called)).toBe("acme@acme: hi");
  });

  it("covers only the layer it is provided to, so one binding serves public and private actions", async () => {
    const web = serve(
      Layer.mergeAll(
        ActionHttp.layer(Http, open),
        ActionHttp.layer(Http, guarded).pipe(Layer.provide(authenticate)),
      ),
    );

    const anyone = await web.handler(call("public", {}));
    expect(anyone.status).toBe(200);
    expect(anyone.headers.has("cache-control")).toBe(false);

    const refused = await web.handler(call("secret", { note: "hi" }));
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toBe("Bearer");

    expect(await (await web.handler(call("secret", { note: "hi" }, "alice"))).json()).toBe(
      "alice: hi",
    );
  });

  it("runs before decoding, so an unauthenticated caller learns nothing of the input", async () => {
    const web = serve(ActionHttp.layer(Http, guarded).pipe(Layer.provide(authenticate)));

    expect((await web.handler(call("secret", { note: 42 }))).status).toBe(401);
    expect((await web.handler(call("secret", { note: 42 }, "alice"))).status).toBe(400);
  });

  it("authenticates an MCP endpoint as a whole, public tools included", async () => {
    const web = serve(
      ActionMcp.layerHttp([open, guarded], { name: "test", version: "0" }).pipe(
        Layer.provide(authenticate),
      ),
    );

    // One route: every tool of it is authenticated.
    const anonymous = Testing.mcpClient([Secret, Public]);

    for (const refused of [
      Effect.flatMap(anonymous, (mcp) => mcp.secret({ note: "hi" })),
      Effect.flatMap(anonymous, (mcp) => mcp.public()),
    ]) {
      expect(await against(web, Effect.flip(refused))).toBeInstanceOf(Action.Unauthenticated);
    }

    const alice = Testing.mcpClient([Secret], {
      transformClient: HttpClient.mapRequest(HttpClientRequest.setHeader("authorization", "alice")),
    });

    expect(
      await against(
        web,
        Effect.flatMap(alice, (mcp) => mcp.secret({ note: "hi" })),
      ),
    ).toBe("alice: hi");
  });

  it("leaves identity to the host on a local surface", async () => {
    const { toolkit, layer } = ActionToolkit.make(guarded);

    const results = await Effect.gen(function* () {
      const tools = yield* toolkit;

      return yield* Stream.runCollect(yield* tools.handle("secret", { note: "hi" }));
    }).pipe(
      Effect.provideService(Identity, { id: "host" }),
      Effect.provide(layer),
      Effect.scoped,
      Effect.runPromise,
    );

    expect(results).toMatchObject([{ isFailure: false, result: "host: hi" }]);
  });
});

describe("Authentication.make combined with other middleware", () => {
  class Tenant extends Context.Service<Tenant, string>()("test/Tenant") {}

  class Verifier extends Context.Service<
    Verifier,
    {
      readonly verify: (
        tenant: string,
        token: string,
      ) => Effect.Effect<{ readonly id: string }, Action.Unauthenticated>;
    }
  >()("test/Verifier") {}

  const resource = {
    resource: "https://api.example.com/mcp",
    authorizationServers: ["https://auth.example.com"],
  } as const;

  const metadata = "https://api.example.com/.well-known/oauth-protected-resource/mcp";

  /** A verifier layer counting its builds; `bad` is no valid token. */
  const verifiers = () => {
    const builds = { count: 0 };

    const layer = Layer.effect(
      Verifier,
      Effect.sync(() => {
        builds.count++;

        return {
          verify: (tenant: string, token: string) =>
            token === "bad"
              ? Effect.fail(new Action.Unauthenticated({ message: "Invalid token." }))
              : Effect.succeed({ id: `${token}@${tenant}` }),
        };
      }),
    );

    return { builds, layer };
  };

  /** The host's own middleware: each request's tenant, from its `x-tenant` header. */
  const resolveTenant = HttpRouter.middleware<{ provides: Tenant }>()((route) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      Effect.provideService(route, Tenant, request.headers["x-tenant"] ?? "none"),
    ),
  );

  /** The host's own middleware reading the identity: marks each response with its caller. */
  const accessLog = HttpRouter.middleware()((route) =>
    Effect.flatMap(Identity, ({ id }) =>
      Effect.map(route, HttpServerResponse.setHeader("x-caller", id)),
    ),
  );

  /** A handler-style builder: the verifier at startup, the tenant and token per request. */
  const build = Effect.gen(function* () {
    const { verify } = yield* Verifier;

    return Effect.gen(function* () {
      const tenant = yield* Tenant;

      return yield* verify(tenant, Redacted.value(yield* Authentication.bearerToken));
    });
  });

  const authentication = Authentication.make(Identity, build, resource);

  const WhoAmI = Action.make("whoAmI", {
    description: "Name the authenticated caller",
    access: "read",
    success: Schema.String,
  });

  const Http = ActionHttp.make([WhoAmI]);

  /** A tenant marked `locked` needs the `admin` scope: the hook's step-up refusal. */
  const whoAmI = Action.implement(
    WhoAmI,
    () => Effect.map(Identity, ({ id }) => id),
    () =>
      Effect.flatMap(Identity, ({ id }) =>
        id.endsWith("@locked")
          ? Effect.fail(new Action.Forbidden({ scopes: ["admin"] }))
          : Effect.void,
      ),
  );

  const call = (headers: Record<string, string>) =>
    new Request("https://api.example.com/api/whoAmI", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: "{}",
    });

  /** `Testing.mcpClient`'s `whoAmI` call, carrying `headers`. */
  const mcpCall = (headers: Record<string, string>) =>
    Effect.flatMap(
      Testing.mcpClient([WhoAmI], {
        transformClient: HttpClient.mapRequest(HttpClientRequest.setHeaders(headers)),
      }),
      (mcp) => mcp.whoAmI(),
    );

  const stepUp = `Bearer error="insufficient_scope", scope="admin", resource_metadata="${metadata}", error_description="Not allowed."`;

  it("reads a request service from middleware combined before it, over HTTP and MCP, building its services once", async () => {
    const { builds, layer } = verifiers();

    const web = serve(
      Layer.mergeAll(
        ActionHttp.layer(Http, whoAmI),
        ActionMcp.layerHttp(whoAmI, { name: "test", version: "0" }),
      ).pipe(Layer.provide(authentication.combine(resolveTenant).layer.pipe(Layer.provide(layer)))),
    );

    const acme = await web.handler(call({ authorization: "Bearer alice", "x-tenant": "acme" }));
    const globex = await web.handler(call({ authorization: "Bearer bob", "x-tenant": "globex" }));
    expect([await acme.json(), await globex.json()]).toEqual(["alice@acme", "bob@globex"]);

    expect(
      await against(web, mcpCall({ authorization: "Bearer carol", "x-tenant": "initech" })),
    ).toBe("carol@initech");

    // Its refusals and challenges are the same combined.
    const anonymous = await web.handler(call({ "x-tenant": "acme" }));
    expect([anonymous.status, anonymous.headers.get("www-authenticate")]).toEqual([
      401,
      `Bearer resource_metadata="${metadata}"`,
    ]);
    expect(anonymous.headers.get("cache-control")).toBe("no-store");

    const invalid = await web.handler(call({ authorization: "Bearer bad", "x-tenant": "acme" }));
    expect([invalid.status, invalid.headers.get("www-authenticate")]).toEqual([
      401,
      `Bearer error="invalid_token", resource_metadata="${metadata}"`,
    ]);

    // A hook's step-up refusal answers the request, over HTTP and over MCP.
    const locked = await web.handler(call({ authorization: "Bearer alice", "x-tenant": "locked" }));
    expect([locked.status, locked.headers.get("www-authenticate")]).toEqual([403, stepUp]);

    const tool = mcpRequest({ method: "tools/call", params: { name: "whoAmI", arguments: {} } });
    tool.headers.set("authorization", "Bearer alice");
    tool.headers.set("x-tenant", "locked");
    const lockedTool = await web.handler(tool);
    expect([lockedTool.status, lockedTool.headers.get("www-authenticate")]).toEqual([403, stepUp]);

    expect(builds.count).toBe(1);
  });

  it("provides the identity to middleware combined after it, which never runs for a refusal", async () => {
    const web = serve(
      ActionHttp.layer(Http, whoAmI).pipe(
        Layer.provide(
          accessLog.combine(Authentication.make(Identity, Effect.succeed(authenticateToken))).layer,
        ),
      ),
    );

    const alice = await web.handler(call({ authorization: "alice" }));
    expect([alice.status, alice.headers.get("x-caller"), await alice.json()]).toEqual([
      200,
      "alice",
      "alice",
    ]);

    const anonymous = await web.handler(call({}));
    expect([
      anonymous.status,
      anonymous.headers.get("www-authenticate"),
      anonymous.headers.get("x-caller"),
    ]).toEqual([401, "Bearer", null]);
  });

  it("composes in both directions at once, and builds once however many compositions use it", async () => {
    const { builds, layer } = verifiers();
    const runs = { count: 0 };

    // The same authentication, counting the runs of its builder.
    const counted = Authentication.make(
      Identity,
      Effect.andThen(
        Effect.sync(() => runs.count++),
        build,
      ),
      resource,
    );

    const web = serve(
      Layer.mergeAll(
        ActionHttp.layer(Http, whoAmI).pipe(
          Layer.provide(accessLog.combine(counted.combine(resolveTenant)).layer),
        ),
        ActionMcp.layerHttp(whoAmI, { name: "test", version: "0" }).pipe(
          Layer.provide(counted.combine(resolveTenant).layer),
        ),
        ActionMcp.layerHttp(whoAmI, { name: "test", version: "0", path: "/other" }).pipe(
          Layer.provide(counted.combine(resolveTenant).layer),
        ),
      ).pipe(Layer.provide(layer)),
    );

    for (const tenant of ["globex", "acme"]) {
      const alice = await web.handler(call({ authorization: "Bearer alice", "x-tenant": tenant }));
      expect([alice.status, alice.headers.get("x-caller"), await alice.json()]).toEqual([
        200,
        `alice@${tenant}`,
        `alice@${tenant}`,
      ]);
    }

    expect(await against(web, mcpCall({ authorization: "Bearer bob", "x-tenant": "acme" }))).toBe(
      "bob@acme",
    );

    // Its builder ran once, the verifier it yields was built once, and it published the
    // discovery of its protected resource.
    expect([runs.count, builds.count]).toEqual([1, 1]);
    const discovered = await web.handler(new Request(metadata));
    expect(discovered.status).toBe(200);
    expect(await discovered.json()).toMatchObject({ resource: resource.resource });
  });

  it("serves the documented tenant example over HTTP and MCP", async () => {
    const web = serve(
      Layer.mergeAll(
        ActionHttp.layer(ExampleHttp, userActions),
        ActionMcp.layerHttp(userActions, { name: "tenants", version: "0" }),
      ).pipe(Layer.provide(tenantAuthentication), Layer.provide(Users.layerMemory)),
    );

    const whoAmIAt = (host: string, token?: string) =>
      web.handler(
        new Request(`http://${host}/api/whoAmI`, {
          method: "POST",
          headers: {
            host,
            "content-type": "application/json",
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          },
          body: "{}",
        }),
      );

    const alice = await whoAmIAt("acme.example.com", "alice");
    expect([alice.status, alice.headers.get("x-actor"), await alice.json()]).toEqual([
      200,
      "alice",
      { id: "alice", tenantId: "acme" },
    ]);

    // Another tenant's actor is refused by the authentication; the caller is never named.
    const outsider = await whoAmIAt("acme.example.com", "bob");
    expect([outsider.status, outsider.headers.get("x-actor")]).toEqual([403, null]);
    expect(await outsider.json()).toMatchObject({ message: "Not a member of this tenant." });

    const anonymous = await whoAmIAt("acme.example.com");
    expect([anonymous.status, anonymous.headers.get("www-authenticate")]).toEqual([401, "Bearer"]);

    const bob = Effect.flatMap(
      Testing.mcpClient([ExampleWhoAmI], {
        transformClient: HttpClient.mapRequest(
          HttpClientRequest.setHeaders({ host: "other.example.com", authorization: "Bearer bob" }),
        ),
      }),
      (mcp) => mcp.whoAmI(),
    );

    expect(await against(web, bob)).toEqual({ id: "bob", tenantId: "other" });
  });
});
