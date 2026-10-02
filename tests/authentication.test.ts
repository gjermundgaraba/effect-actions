import { inspect } from "node:util";
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  Client,
  ClientCredentialsProvider,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
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
import { layer as signIn } from "../examples/mcp-sign-in.js";
import { requestPolicy } from "../examples/request-policy.js";
import { Users } from "../examples/users.js";
import { serve } from "./serve.js";
import { mcpRequest, post, rawToolCall, send } from "./requests.js";

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
  it("answers a refusal as JSON before the route runs, and provides the identity otherwise", async () => {
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

    for (const [token, status] of [
      [undefined, 401],
      ["denied", 403],
    ] as const) {
      const response = await web.handler(request(token));
      expect(response.status).toBe(status);
      expect(response.headers.get("content-type")).toContain("application/json");
    }

    expect(calls).toBe(0);
    expect(await (await web.handler(request("alice"))).text()).toBe("alice");
    expect(await (await web.handler(request("bob"))).text()).toBe("bob");
    expect(calls).toBe(2);
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

  it("challenges a hook's 401 as its own, naming the scopes a first login requests", async () => {
    const Read = Action.make("read", { description: "Read", access: "read" });

    const resource = {
      resource: "https://api.example.com/api",
      authorizationServers: ["https://auth.example.com"],
      scopesRequired: ["docs:read"],
    } as const;

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

    // The caller presented a token, which the hook did not take.
    const hooked = await web.handler(
      new Request("http://localhost/api/read", {
        method: "POST",
        headers: { authorization: "Bearer alice", "content-type": "application/json" },
        body: "{}",
      }),
    );

    expect(hooked.status).toBe(401);
    expect(hooked.headers.get("www-authenticate")).toBe(
      'Bearer error="invalid_token", scope="docs:read", resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/api"',
    );
  });

  it("challenges a hook's refusal naming scopes with insufficient_scope, describing it only in RFC 6750's characters", async () => {
    const Write = Action.make("write", { description: "Write", access: "write" });

    const app = Action.implement(
      Write,
      () => Effect.void,
      () =>
        Effect.fail(new Action.Forbidden({ message: 'Needs "write".', scopes: ["a:write", "b"] })),
    );

    const web = serve(
      ActionHttp.layer(ActionHttp.make([Write]), app).pipe(
        Layer.provide(
          Authentication.make(Identity, Effect.succeed(Effect.succeed({ id: "caller" })), {
            resource: "https://api.example.com/api",
            authorizationServers: ["https://auth.example.com"],
          }).layer,
        ),
      ),
    );

    // Its message is no RFC 6750 error description, so it has none.
    const hooked = await web.handler(post("/api/write"));
    expect(hooked.status).toBe(403);
    expect(hooked.headers.get("www-authenticate")).toBe(
      'Bearer error="insufficient_scope", scope="a:write b", resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/api"',
    );
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

  it.effect.each([
    ["an HTTP", "returns", 200],
    ["an HTTP", "dies", 500],
    ["an MCP", "returns", 200],
    ["an MCP", "dies", 200],
  ] as const)(
    "keeps the resources it acquires alive for %s handler that %s, releasing them after the response",
    ([transport, outcome, status]) =>
      Effect.gen(function* () {
        const events: string[] = [];
        const releasing = yield* Deferred.make<void>();
        const allowRelease = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();

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

        const app = Action.implement(
          Identify,
          () =>
            Effect.gen(function* () {
              expect(events).toEqual(["acquire"]);
              events.push("handler");
              const { id } = yield* Identity;

              return outcome === "returns" ? id : yield* Effect.die(new Error("handler failed"));
            }),
          Action.allowAll,
        );

        const routes =
          transport === "an HTTP"
            ? ActionHttp.layer(ActionHttp.make([Identify]), app).pipe(Layer.provide(auth.layer))
            : ActionMcp.layerHttp(app, { name: "scope-test", version: "0" }).pipe(
                Layer.provide(auth.layer),
              );

        yield* Effect.gen(function* () {
          const response = yield* send(
            transport === "an HTTP" ? post("/api/identify") : rawToolCall("identify"),
          );

          expect(response.status).toBe(status);
          expect(response.headers["cache-control"]).toBe("no-store");
          expect((yield* response.text).includes("alice")).toBe(outcome === "returns");
          // Web handlers resolve the Response before asynchronous request finalizers
          // finish; streaming responses begin cleanup when their body is consumed.
          yield* Deferred.await(releasing);
          expect(events).toEqual(["acquire", "handler"]);
          yield* Deferred.succeed(allowRelease, undefined);
          yield* Deferred.await(released);
          expect(events).toEqual(["acquire", "handler", "release"]);
        }).pipe(
          // A failed test still lets the release finish, before the routes are released.
          Effect.ensuring(Deferred.succeed(allowRelease, undefined)),
          Effect.provide(Testing.layer(routes)),
        );
      }),
  );

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
    Effect.map(Effect.option(withAuthorization(authorization)), Option.map(Redacted.value));

  it.effect("reads the token of a Bearer authorization, whatever the scheme's case", () =>
    Effect.gen(function* () {
      expect(yield* tokenOf("Bearer alice")).toEqual(Option.some("alice"));
      expect(yield* tokenOf("bearer alice")).toEqual(Option.some("alice"));
      expect(yield* tokenOf("BEARER alice")).toEqual(Option.some("alice"));
    }),
  );

  it.effect("keeps the token out of anything that prints it", () =>
    Effect.gen(function* () {
      const token = yield* withAuthorization("Bearer alice");

      expect(inspect(token)).not.toContain("alice");
      expect(JSON.stringify({ token })).not.toContain("alice");
    }),
  );

  it.effect("fails without an authorization, with another scheme, or without a token", () =>
    Effect.gen(function* () {
      expect(yield* tokenOf()).toEqual(Option.none());
      expect(yield* tokenOf("Basic YWxpY2U6c2VjcmV0")).toEqual(Option.none());
      expect(yield* tokenOf("Bearer")).toEqual(Option.none());
      expect(yield* tokenOf("Bearer ")).toEqual(Option.none());
      expect(yield* tokenOf("Bearer two tokens")).toEqual(Option.none());
    }),
  );

  it.effect("fails with the built-in 401, so authentication needs no branch of its own", () =>
    Effect.gen(function* () {
      expect(yield* Effect.flip(withAuthorization())).toEqual(
        new Action.Unauthenticated({ message: "A bearer token is required." }),
      );
    }),
  );
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

  const open = Action.implement(Public, () => Effect.succeed("anyone"), Action.allowAll);

  const guarded = Action.implement(
    Secret,
    ({ note }) => Effect.map(Identity, ({ id }) => `${id}: ${note}`),
    Action.allowAll,
  );

  const call = (path: string, body: Schema.Json, token?: string) => {
    const request = post(`/api/${path}`, body);

    if (token !== undefined) request.headers.set("authorization", token);

    return request;
  };

  it.effect("builds its services once, on every HTTP surface it covers", () =>
    Effect.gen(function* () {
      let built = 0;

      const verify = Authentication.make(
        Identity,
        Effect.gen(function* () {
          built++;

          const { prefix } = yield* Tokens;

          return Effect.map(Authentication.bearerToken, (token) => ({
            id: `${prefix}${Redacted.value(token)}`,
          }));
        }),
      );

      // What its build yields is a startup requirement of the layers it covers, not of each
      // request; the request is the router's.
      expectTypeOf<Layer.Services<typeof verify.layer>>().toEqualTypeOf<
        HttpRouter.HttpRouter | Tokens
      >();

      const routes = Layer.mergeAll(
        ActionHttp.layer(Http, guarded),
        ActionMcp.layerHttp(guarded, { name: "test", version: "0" }),
      ).pipe(
        Layer.provide(
          verify.layer.pipe(Layer.provide(Layer.succeed(Tokens, { prefix: "actor:" }))),
        ),
      );

      yield* Effect.gen(function* () {
        const response = yield* send(call("secret", { note: "hi" }, "Bearer alice"));

        expect(yield* response.json).toBe("actor:alice: hi");

        const mcp = yield* Testing.mcpClient([Secret], {
          transformClient: HttpClient.mapRequest(
            HttpClientRequest.setHeader("authorization", "Bearer alice"),
          ),
        });

        expect(yield* mcp.secret({ note: "hi" })).toBe("actor:alice: hi");
      }).pipe(Effect.provide(Testing.layer(routes)));

      expect(built).toBe(1);
    }),
  );

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

  it.effect("authenticates an MCP endpoint as a whole, public tools included", () =>
    Effect.gen(function* () {
      // One route: every tool of it is authenticated.
      const anonymous = Testing.mcpClient([Secret, Public]);

      for (const refused of [
        Effect.flatMap(anonymous, (mcp) => mcp.secret({ note: "hi" })),
        Effect.flatMap(anonymous, (mcp) => mcp.public()),
      ]) {
        expect(yield* Effect.flip(refused)).toBeInstanceOf(Action.Unauthenticated);
      }

      const alice = yield* Testing.mcpClient([Secret], {
        transformClient: HttpClient.mapRequest(
          HttpClientRequest.setHeader("authorization", "alice"),
        ),
      });

      expect(yield* alice.secret({ note: "hi" })).toBe("alice: hi");
    }).pipe(
      Effect.provide(
        Testing.layer(
          ActionMcp.layerHttp([open, guarded], { name: "test", version: "0" }).pipe(
            Layer.provide(authenticate),
          ),
        ),
      ),
    ),
  );

  it.effect("leaves identity to the host on a local surface", () =>
    Effect.gen(function* () {
      const { toolkit, layer } = ActionToolkit.make(guarded);

      const results = yield* Effect.gen(function* () {
        const tools = yield* toolkit;

        return yield* Stream.runCollect(yield* tools.handle("secret", { note: "hi" }));
      }).pipe(Effect.provideService(Identity, { id: "host" }), Effect.provide(layer));

      expect(results).toMatchObject([{ isFailure: false, result: "host: hi" }]);
    }),
  );
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

  it.effect("reads a request service from middleware combined before it, over HTTP and MCP", () =>
    Effect.gen(function* () {
      const acme = yield* send(call({ authorization: "Bearer alice", "x-tenant": "acme" }));
      const globex = yield* send(call({ authorization: "Bearer bob", "x-tenant": "globex" }));
      expect([yield* acme.json, yield* globex.json]).toEqual(["alice@acme", "bob@globex"]);

      expect(yield* mcpCall({ authorization: "Bearer carol", "x-tenant": "initech" })).toBe(
        "carol@initech",
      );

      // Its refusals and challenges are the same combined.
      const anonymous = yield* send(call({ "x-tenant": "acme" }));
      expect([anonymous.status, anonymous.headers["www-authenticate"]]).toEqual([
        401,
        `Bearer resource_metadata="${metadata}"`,
      ]);
      expect(anonymous.headers["cache-control"]).toBe("no-store");

      const invalid = yield* send(call({ authorization: "Bearer bad", "x-tenant": "acme" }));
      expect([invalid.status, invalid.headers["www-authenticate"]]).toEqual([
        401,
        `Bearer error="invalid_token", resource_metadata="${metadata}"`,
      ]);

      // A hook's step-up refusal answers the request, over HTTP and over MCP.
      const locked = yield* send(call({ authorization: "Bearer alice", "x-tenant": "locked" }));
      expect([locked.status, locked.headers["www-authenticate"]]).toEqual([403, stepUp]);

      const tool = mcpRequest({ method: "tools/call", params: { name: "whoAmI", arguments: {} } });
      tool.headers.set("authorization", "Bearer alice");
      tool.headers.set("x-tenant", "locked");
      const lockedTool = yield* send(tool);
      expect([lockedTool.status, lockedTool.headers["www-authenticate"]]).toEqual([403, stepUp]);
    }).pipe(
      Effect.provide(
        Testing.layer(
          Layer.mergeAll(
            ActionHttp.layer(Http, whoAmI),
            ActionMcp.layerHttp(whoAmI, { name: "test", version: "0" }),
          ).pipe(
            Layer.provide(
              authentication.combine(resolveTenant).layer.pipe(Layer.provide(verifiers().layer)),
            ),
          ),
        ),
      ),
    ),
  );

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

  it.effect(
    "composes in both directions at once, and builds once however many compositions use it",
    () =>
      Effect.gen(function* () {
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

        const routes = Layer.mergeAll(
          ActionHttp.layer(Http, whoAmI).pipe(
            Layer.provide(accessLog.combine(counted.combine(resolveTenant)).layer),
          ),
          ActionMcp.layerHttp(whoAmI, { name: "test", version: "0" }).pipe(
            Layer.provide(counted.combine(resolveTenant).layer),
          ),
          ActionMcp.layerHttp(whoAmI, { name: "test", version: "0", path: "/other" }).pipe(
            Layer.provide(counted.combine(resolveTenant).layer),
          ),
        ).pipe(Layer.provide(layer));

        yield* Effect.gen(function* () {
          for (const tenant of ["globex", "acme"]) {
            const alice = yield* send(call({ authorization: "Bearer alice", "x-tenant": tenant }));

            expect([alice.status, alice.headers["x-caller"], yield* alice.json]).toEqual([
              200,
              `alice@${tenant}`,
              `alice@${tenant}`,
            ]);
          }

          expect(yield* mcpCall({ authorization: "Bearer bob", "x-tenant": "acme" })).toBe(
            "bob@acme",
          );
        }).pipe(Effect.provide(Testing.layer(routes)));

        // Its builder ran once, and the verifier it yields was built once.
        expect([runs.count, builds.count]).toEqual([1, 1]);
      }),
  );

  it.effect("serves the documented tenant example over HTTP and MCP", () =>
    Effect.gen(function* () {
      const whoAmIAt = (host: string, token?: string) =>
        send(
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

      const alice = yield* whoAmIAt("acme.example.com", "alice");
      expect([alice.status, alice.headers["x-actor"], yield* alice.json]).toEqual([
        200,
        "alice",
        { id: "alice", tenantId: "acme" },
      ]);

      // Another tenant's actor is refused by the authentication; the caller is never named.
      const outsider = yield* whoAmIAt("acme.example.com", "bob");
      expect([outsider.status, outsider.headers["x-actor"]]).toEqual([403, undefined]);
      expect(yield* outsider.json).toMatchObject({ message: "Not a member of this tenant." });

      const anonymous = yield* whoAmIAt("acme.example.com");
      expect([anonymous.status, anonymous.headers["www-authenticate"]]).toEqual([401, "Bearer"]);

      const bob = yield* Testing.mcpClient([ExampleWhoAmI], {
        transformClient: HttpClient.mapRequest(
          HttpClientRequest.setHeaders({ host: "other.example.com", authorization: "Bearer bob" }),
        ),
      });

      expect(yield* bob.whoAmI()).toEqual({ id: "bob", tenantId: "other" });
    }).pipe(
      Effect.provide(
        Testing.layer(
          Layer.mergeAll(
            ActionHttp.layer(ExampleHttp, userActions),
            ActionMcp.layerHttp(userActions, { name: "tenants", version: "0" }),
          ).pipe(Layer.provide(tenantAuthentication), Layer.provide(Users.layerMemory)),
        ),
      ),
    ),
  );

  it("refuses a foreign Host or Origin under the example's global policy before the tenant example's combined authentication", async () => {
    const web = serve(
      Layer.mergeAll(
        requestPolicy,
        Layer.mergeAll(
          ActionHttp.layer(ExampleHttp, userActions),
          ActionMcp.layerHttp(userActions, { name: "tenants", version: "0" }),
        ).pipe(Layer.provide(tenantAuthentication)),
      ).pipe(Layer.provide(Users.layerMemory)),
    );

    /** The status, challenge and text of a POST of `{}` to `url`. */
    const answer = async (url: string, headers: Record<string, string> = {}) => {
      const response = await web.handler(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: "{}",
        }),
      );

      return [response.status, response.headers.get("www-authenticate"), await response.text()];
    };

    // Refused before routing: no part of the combination read a credential, so no 401.
    expect(await answer("http://evil.example/api/whoAmI")).toEqual([403, null, "Host not allowed"]);
    expect(await answer("http://evil.example/mcp", { authorization: "Bearer forged" })).toEqual([
      403,
      null,
      "Host not allowed",
    ]);
    expect(await answer("http://localhost/api/whoAmI", { origin: "https://evil.example" })).toEqual(
      [403, null, "Origin not allowed"],
    );

    // What the policy lets through, the authentication answers.
    expect((await answer("http://localhost/api/whoAmI")).slice(0, 2)).toEqual([401, "Bearer"]);
  });

  /** What the Host check below saw of the tenant, once per request it refused. */
  const seen: Array<string> = [];

  /** A Host check, route middleware: refuses a foreign Host, noting the tenant resolved by then. */
  const hostCheck = HttpRouter.middleware()((route) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = HttpServerRequest.toURL(request.modify({ url: request.originalUrl }));

      if (Option.isSome(url) && url.value.hostname === "api.example.com") return yield* route;

      seen.push(Option.getOrElse(yield* Effect.serviceOption(Tenant), () => "no tenant"));

      return HttpServerResponse.text("Host not allowed", { status: 403 });
    }),
  );

  /** `whoAmI`'s route under `authenticated`, the Host check provided around both. */
  const guarded = <ROut, E, R>(authenticated: Layer.Layer<ROut, E, R>) =>
    ActionHttp.layer(Http, whoAmI).pipe(
      Layer.provide(authenticated),
      Layer.provide(hostCheck.layer),
      Layer.provide(verifiers().layer),
    );

  const bearer = Authentication.make(Identity, Effect.succeed(authenticateToken));

  it.each([
    ["alone", () => serve(guarded(bearer.layer)), 403, ["no tenant"]],
    [
      "combined with resolveTenant",
      () => serve(guarded(authentication.combine(resolveTenant).layer)),
      403,
      ["acme"],
    ],
    [
      "the b of accessLog.combine(b)",
      () => serve(guarded(accessLog.combine(bearer).layer)),
      401,
      [],
    ],
    [
      "inside the b of accessLog.combine(b)",
      () => serve(guarded(accessLog.combine(authentication.combine(resolveTenant)).layer)),
      401,
      [],
    ],
  ])(
    "runs a Host check provided around routes before their authentication only while it is not combined into other middleware: %s",
    async (_, web, status, refused) => {
      seen.length = 0;

      const response = await web().handler(
        new Request("https://evil.example/api/whoAmI", {
          method: "POST",
          headers: { "content-type": "application/json", "x-tenant": "acme" },
          body: "{}",
        }),
      );

      // A 403 is the Host check's, run before the authentication; a 401 the authentication's,
      // run first, where the check never ran.
      expect([response.status, seen]).toEqual([status, refused]);
    },
  );
});

describe("an optional identity on one MCP URL", () => {
  const issuer = "https://auth.example.com";

  /**
   * The documented example's endpoint, behind an OAuth authorization server in memory that
   * issues `alice`'s token for a write scope and `reader`'s otherwise, logging what each
   * side is asked.
   */
  const deployment = () => {
    const web = serve(signIn);
    const log: string[] = [];

    const authorizationServer = async (request: Request): Promise<Response> => {
      const { pathname } = new URL(request.url);

      if (pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["client_credentials"],
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
        });
      }

      const form = new URLSearchParams(await request.text());
      const scope = form.get("scope") ?? "";

      log.push(`token ${scope} for ${form.get("resource")}`);

      return Response.json({
        access_token: scope.split(" ").includes("notes:write") ? "alice" : "reader",
        token_type: "Bearer",
        expires_in: 3600,
        scope,
      });
    };

    const fetch = async (request: Request): Promise<Response> => {
      if (request.url.startsWith(issuer)) return authorizationServer(request);

      const response = await web.handler(request);
      const called = request.headers.get("mcp-name") ?? request.headers.get("mcp-method");

      log.push(
        `${called ?? new URL(request.url).pathname} ${request.headers.get("authorization") ?? "signed out"}: ${response.status}`,
      );

      return response;
    };

    return { web, log, fetch };
  };

  it("serves a signed-out caller its listing and public tools, and signs the official client in on a protected one", async () => {
    const { log, fetch } = deployment();

    const client = new Client(
      { name: "test", version: "0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );

    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL("http://localhost:3000/mcp"), {
          fetch: (input, init) => fetch(new Request(input, init)),
          authProvider: new ClientCredentialsProvider({ clientId: "host", clientSecret: "secret" }),
        }),
      );

      const listed = await client.listTools();
      const found = await client.callTool({ name: "search", arguments: { query: "effect" } });
      const saved = await client.callTool({ name: "save", arguments: { text: "hi" } });

      expect(listed.tools.map((tool) => tool.name)).toEqual(["search", "save"]);
      expect(found.structuredContent).toEqual(["A public note about effect."]);
      expect(saved.structuredContent).toBe("alice saved: hi");
    } finally {
      await client.close();
    }

    // Signed out, the listing and the public tool answer; the protected one's hook answers
    // 401, on which the client signs in for the scope it names, then 403 naming the scope a
    // write needs, on which it steps up. Each token is requested for this resource.
    expect(log).toEqual([
      "server/discover signed out: 200",
      "tools/list signed out: 200",
      "search signed out: 200",
      "save signed out: 401",
      "/.well-known/oauth-protected-resource/mcp signed out: 200",
      "token notes:read for http://localhost:3000/mcp",
      "save Bearer reader: 403",
      "/.well-known/oauth-protected-resource/mcp signed out: 200",
      "token notes:read notes:write for http://localhost:3000/mcp",
      "save Bearer alice: 200",
    ]);
  });

  it("still refuses a token that does not verify, on a public tool too, and decodes a protected tool's input first", async () => {
    const { web } = deployment();

    const forged = await web.handler(
      mcpRequest({
        method: "tools/call",
        params: { name: "search", arguments: { query: "effect" } },
        headers: { authorization: "Bearer forged" },
      }),
    );

    expect(forged.status).toBe(401);
    expect(forged.headers.get("www-authenticate")).toContain('error="invalid_token"');

    // A signed-out caller reaches the protected tool's input decoding, before its hook.
    const malformed = await web.handler(rawToolCall("save", { text: 1 }));

    expect(malformed.status).toBe(200);
    expect(await malformed.json()).toMatchObject({ result: { isError: true } });

    const refused = await web.handler(rawToolCall("save", { text: "hi" }));

    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual(
      Schema.encodeSync(Action.Unauthenticated)(
        new Action.Unauthenticated({ message: "Sign in to use this tool." }),
      ),
    );
  });
});
