import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  Client,
  ClientCredentialsProvider,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Predicate,
  Redacted,
  Schema,
  Stream,
} from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { HttpApiMiddleware, HttpApiSecurity, OpenApi } from "effect/http-api";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as ActionToolkit from "../src/ActionToolkit.js";
import * as Authentication from "../src/Authentication.js";
import * as Testing from "../src/Testing.js";
import { layer as app } from "../examples/app.js";
import { routes as tenantRoutes } from "../examples/authentication-tenant.js";
import { Http as ExampleHttp } from "../examples/binding.js";
import { requestPolicy } from "../examples/request-policy.js";
import { Users } from "../examples/users.js";
import { serve } from "./serve.js";
import { as, mcpRequest, post, rawToolCall, send, valueOf, withBearer } from "./requests.js";

class Identity extends Context.Service<Identity, { readonly id: string }>()("test/Identity") {}

class Tokens extends Context.Service<Tokens, { readonly prefix: string }>()("test/Tokens") {}

class Private extends Schema.TaggedError<Private>()("Private", { message: Schema.String }) {}

/** How a remote caller proves it is an `Identity`: a bearer token. */
const Login = Authentication.make("test.Login", Identity);

const Identify = Action.make("identify", {
  description: "Name the authenticated caller",
  readOnly: true,
  caller: Identity,
  success: Schema.String,
});

const IdentifyHttp = ActionHttp.make([Identify], { authentication: Login });

const identify = Action.implement(Identify, () => Effect.map(Identity, ({ id }) => id), {
  authorize: Action.allowAll,
});

/** `identify`'s request, presenting `authorization` as it is. */
const request = (authorization?: string) => {
  const sent = post("/api/identify");

  if (authorization !== undefined) sent.headers.set("authorization", authorization);

  return sent;
};

/** Verify the token as the identity it names, refusing `denied`. */
const verify = (token: Redacted.Redacted<string>) =>
  Redacted.value(token) === "denied"
    ? Effect.fail(new Action.Forbidden({ message: "Denied token" }))
    : Effect.succeed({ id: Redacted.value(token) });

const authenticate = Authentication.layer(Login, verify);

describe("Authentication.make", () => {
  it("refuses a name that is no OpenAPI component key, which it is", () => {
    for (const name of ["app/Login", "app:Login", "Log in", ""]) {
      expect(() => Authentication.make(name, Identity)).toThrow(
        `Invalid authentication name: ${JSON.stringify(name)}, not an OpenAPI key`,
      );
    }

    expect(Authentication.make("app.Login-2_x", Identity).name).toBe("app.Login-2_x");
  });

  it("refuses a security that is no native scheme, such as the record of schemes it once took", () => {
    for (const security of [{}, { bearer: HttpApiSecurity.bearer }, "Bearer"]) {
      // @ts-expect-error Plain JavaScript can pass anything.
      expect(() => Authentication.make("test.Refused", Identity, { security })).toThrow(
        "Authentication takes one native HttpApiSecurity scheme",
      );
    }
  });
});

describe("a protected action's descriptor", () => {
  class Other extends Context.Service<Other, { readonly id: string }>()("test/Other") {}

  const OtherLogin = Authentication.make("test.OtherLogin", Other);

  const refused = "Protected action 'identify' requires its matching authentication descriptor";

  it("is required, and of the identity the action declares, where plain JavaScript serves it", () => {
    for (const authentication of [undefined, OtherLogin]) {
      // @ts-expect-error The check exists for callers the compiler never sees.
      expect(() => ActionHttp.make([Identify], { authentication })).toThrow(refused);

      expect(() =>
        // @ts-expect-error The check exists for callers the compiler never sees.
        ActionMcp.layerHttp(identify, { name: "test", version: "0", authentication }),
      ).toThrow(refused);
    }

    // A binding whose descriptor was swapped after `make` is refused where it is served.
    const swapped = { ...IdentifyHttp, authentication: OtherLogin };

    expect(() => ActionHttp.layer(swapped, identify)).toThrow(refused);
  });
});

describe("Authentication.layer", () => {
  it("dies building a provider given no verifier, as plain JavaScript may", async () => {
    // @ts-expect-error Without a verifier, the layer's request requirement is unknown.
    const missing: Layer.Layer<unknown, never, HttpRouter.HttpRouter> = Authentication.layer(
      Login,
      // @ts-expect-error The check exists for callers the compiler never sees.
      undefined,
    );

    const exit = await Effect.runPromiseExit(
      Layer.build(missing).pipe(Effect.provide(HttpRouter.layer), Effect.scoped),
    );

    expect(String(exit)).toContain(
      "Missing verify: pass a verify function, or an Effect building one",
    );
  });

  it("answers a refusal as JSON before the action runs, and provides the identity otherwise", async () => {
    let calls = 0;

    const counted = Action.implement(
      Identify,
      () =>
        Effect.map(Identity, ({ id }) => {
          calls++;

          return id;
        }),
      { authorize: Action.allowAll },
    );

    const web = serve(ActionHttp.layer(IdentifyHttp, counted).pipe(Layer.provide(authenticate)));

    for (const [token, status] of [
      [undefined, 401],
      ["denied", 403],
    ] as const) {
      const response = await web.handler(
        token === undefined ? request() : withBearer(request(), token),
      );

      expect(response.status).toBe(status);
      expect(response.headers.get("content-type")).toContain("application/json");
    }

    expect(calls).toBe(0);
    expect(await (await web.handler(withBearer(request(), "alice"))).json()).toBe("alice");
    expect(await (await web.handler(withBearer(request(), "bob"))).json()).toBe("bob");
    expect(calls).toBe(2);
  });

  it("sends the host's own response instead, with its status and headers", async () => {
    const own = Authentication.layer(Login, (token: Redacted.Redacted<string>) =>
      Redacted.value(token) === "expired"
        ? Effect.fail(
            HttpServerResponse.text("Sign in again", {
              status: 401,
              headers: { "www-authenticate": 'Bearer realm="host"' },
            }),
          )
        : Effect.succeed({ id: Redacted.value(token) }),
    );

    const web = serve(ActionHttp.layer(IdentifyHttp, identify).pipe(Layer.provide(own)));

    const response = await web.handler(withBearer(request(), "expired"));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="host"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("Sign in again");
    expect(await (await web.handler(withBearer(request(), "alice"))).json()).toBe("alice");
  });

  it("challenges every 401 it covers that has no challenge of its own", async () => {
    const Refuse = Action.make("refuse", {
      description: "Refused by its handler",
      readOnly: true,
      caller: Identity,
    });

    const own = Authentication.layer(Login, (token: Redacted.Redacted<string>) =>
      Redacted.value(token) === "expired"
        ? Effect.fail(HttpServerResponse.text("Sign in again", { status: 401 }))
        : Effect.succeed({ id: Redacted.value(token) }),
    );

    const web = serve(
      ActionHttp.layer(
        ActionHttp.make([Refuse], { authentication: Login }),
        Action.implement(Refuse, () => Effect.fail(new Action.Unauthenticated()), {
          authorize: Action.allowAll,
        }),
      ).pipe(Layer.provide(own)),
    );

    // A request presenting no token, the host's own response to one, and a handler's own 401
    // to a request whose token the authentication took.
    const anonymous = await web.handler(post("/api/refuse"));
    const host = await web.handler(withBearer(post("/api/refuse"), "expired"));
    const route = await web.handler(withBearer(post("/api/refuse"), "alice"));

    expect([anonymous.status, host.status, route.status]).toEqual([401, 401, 401]);
    expect(anonymous.headers.get("www-authenticate")).toBe("Bearer");
    expect(host.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
    expect(route.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
  });

  it("challenges an authorizer's 401 as its own, naming the scopes a first login requests", async () => {
    const Read = Action.make("read", { description: "Read", readOnly: true, caller: Identity });

    const web = serve(
      ActionHttp.layer(
        ActionHttp.make([Read], { authentication: Login }),
        Action.implement(Read, () => Effect.void, {
          authorize: () => Effect.fail(new Action.Unauthenticated()),
        }),
      ).pipe(
        Layer.provide(
          Authentication.layer(Login, verify, {
            protectedResource: {
              resource: "https://api.example.com/api",
              authorizationServers: ["https://auth.example.com"],
              scopesRequired: ["docs:read"],
            },
          }),
        ),
      ),
    );

    // The caller presented a token, which the authorizer did not take.
    const refused = await web.handler(withBearer(post("/api/read"), "alice"));

    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toBe(
      'Bearer error="invalid_token", scope="docs:read", resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/api"',
    );
  });

  it("challenges an authorizer's refusal naming scopes with insufficient_scope, describing it only in RFC 6750's characters", async () => {
    const Write = Action.make("write", { description: "Write", readOnly: false, caller: Identity });

    const write = Action.implement(Write, () => Effect.void, {
      authorize: () =>
        Effect.fail(new Action.Forbidden({ message: 'Needs "write".', scopes: ["a:write", "b"] })),
    });

    const web = serve(
      ActionHttp.layer(ActionHttp.make([Write], { authentication: Login }), write).pipe(
        Layer.provide(
          Authentication.layer(Login, verify, {
            protectedResource: {
              resource: "https://api.example.com/api",
              authorizationServers: ["https://auth.example.com"],
            },
          }),
        ),
      ),
    );

    // Its message is no RFC 6750 error description, so it has none.
    const refused = await web.handler(withBearer(post("/api/write"), "caller"));
    expect(refused.status).toBe(403);
    expect(refused.headers.get("www-authenticate")).toBe(
      'Bearer error="insufficient_scope", scope="a:write b", resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/api"',
    );
  });

  it("refuses a scope that is no OAuth scope token", () => {
    expect(new Action.Forbidden({ scopes: ["users:write"] }).scopes).toEqual(["users:write"]);
    expect(() => new Action.Forbidden({ scopes: ["has space"] })).toThrow();
  });

  it("rejects any other failure in the types, and answers it with an empty 500", async () => {
    type Verify = Authentication.Verify<{ readonly id: string }, typeof Login.security, never>;

    // @ts-expect-error Only a refusal or a response may fail authentication; plain JavaScript can still fail with anything.
    const leaking: Verify = () => Effect.fail(new Private({ message: "Undeclared" }));

    const web = serve(
      ActionHttp.layer(IdentifyHttp, identify).pipe(
        Layer.provide(Authentication.layer(Login, leaking)),
      ),
    );

    const response = await web.handler(withBearer(request(), "alice"));
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

        const acquiring = Authentication.layer(Login, () =>
          Effect.acquireRelease(
            Effect.sync(() => {
              events.push("acquire");

              return { id: "alice" };
            }),
            () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(releasing, undefined);

                // Released before the handler, it skips the gate and fails the order checks.
                if (events.includes("handler")) yield* Deferred.await(allowRelease);
                events.push("release");
                yield* Deferred.succeed(released, undefined);
              }),
          ),
        );

        const reading = Action.implement(
          Identify,
          () =>
            Effect.gen(function* () {
              expect(events).toEqual(["acquire"]);
              events.push("handler");
              const { id } = yield* Identity;

              return outcome === "returns" ? id : yield* Effect.die(new Error("handler failed"));
            }),
          { authorize: Action.allowAll },
        );

        const routes =
          transport === "an HTTP"
            ? ActionHttp.layer(IdentifyHttp, reading).pipe(Layer.provide(acquiring))
            : ActionMcp.layerHttp(reading, {
                name: "scope-test",
                version: "0",
                authentication: Login,
              }).pipe(Layer.provide(acquiring));

        yield* Effect.gen(function* () {
          const response = yield* send(
            withBearer(transport === "an HTTP" ? request() : rawToolCall("identify"), "alice"),
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

  it("never lets a protected action's failure be cached, however enclosing middleware answers it", async () => {
    class Hidden extends Schema.TaggedError<Hidden>()(
      "Hidden",
      { message: Schema.String },
      { httpApiStatus: 404 },
    ) {}

    const Find = Action.make("find", {
      description: "Find something private",
      readOnly: true,
      caller: Identity,
      errors: [Hidden],
    });

    const find = Action.implement(
      Find,
      () => Effect.flatMap(Identity, ({ id }) => new Hidden({ message: `private data for ${id}` })),
      { authorize: Action.allowAll },
    );

    // The host's own middleware, answering responses as public and cacheable.
    const outer = HttpRouter.middleware()((route) =>
      Effect.map(route, HttpServerResponse.setHeader("cache-control", "public, max-age=60")),
    );

    const web = serve(
      ActionHttp.layer(ActionHttp.make([Find], { authentication: Login }), find).pipe(
        Layer.provide(authenticate),
        Layer.provide(outer.layer),
      ),
    );

    const response = await web.handler(withBearer(post("/api/find"), "alice"));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ message: "private data for alice" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps the caching a route states, and no-stores every other response", async () => {
    const Artifact = Action.make("artifact", {
      description: "An immutable artifact of the caller's",
      readOnly: true,
      caller: Identity,
      success: Schema.String,
    });

    const Http = ActionHttp.make([Artifact, Identify], { authentication: Login });

    // The artifact's own caching, stated by its layer's middleware inside the authentication.
    class Immutable extends HttpApiMiddleware.Service<Immutable>()("test/Immutable") {}

    const immutable = Layer.succeed(Immutable, (route) =>
      Effect.map(
        route,
        HttpServerResponse.setHeader("cache-control", "private, max-age=31536000, immutable"),
      ),
    );

    const artifact = Action.implement(Artifact, () => Effect.succeed("artifact"), {
      authorize: Action.allowAll,
    });

    const web = serve(
      Layer.mergeAll(
        ActionHttp.layer(Http, artifact, { middleware: [Immutable] }).pipe(
          Layer.provide(immutable),
        ),
        ActionHttp.layer(Http, identify),
      ).pipe(Layer.provide(authenticate)),
    );

    const stated = await web.handler(withBearer(post("/api/artifact"), "alice"));
    expect(stated.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect((await web.handler(withBearer(request(), "alice"))).headers.get("cache-control")).toBe(
      "no-store",
    );
  });
});

describe("Authentication.layer's refusals", () => {
  const resource = {
    resource: "https://api.example.com/mcp",
    authorizationServers: ["https://auth.example.com"],
    scopesRequired: ["read"],
  } as const;

  const metadata = "https://api.example.com/.well-known/oauth-protected-resource/mcp";

  const web = (error: Action.Refusal) =>
    serve(
      ActionHttp.layer(IdentifyHttp, identify).pipe(
        Layer.provide(
          Authentication.layer(Login, () => Effect.fail(error), {
            protectedResource: resource,
          }),
        ),
      ),
    );

  it.each([
    [
      new Action.Unauthenticated(),
      401,
      `Bearer error="invalid_token", scope="read", resource_metadata="${metadata}"`,
    ],
    [
      new Action.Forbidden({ scopes: ["write"] }),
      403,
      `Bearer error="insufficient_scope", scope="write", resource_metadata="${metadata}", error_description="Not allowed."`,
    ],
    [new Action.Forbidden(), 403, null],
  ] as const)(
    "answers %s with its JSON, status and challenge, never cached",
    async (error, status, challenge) => {
      const response = await web(error).handler(request("Bearer x"));

      expect(response.status).toBe(status);
      expect(response.headers.get("www-authenticate")).toBe(challenge);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual(
        Schema.encodeSync(Schema.Union([Action.Unauthenticated, Action.Forbidden]))(error),
      );
    },
  );

  it.each([
    [undefined, `Bearer scope="read", resource_metadata="${metadata}"`],
    ["Bearer x", `Bearer error="invalid_token", scope="read", resource_metadata="${metadata}"`],
    // Another scheme, or no token, presented no bearer token: RFC 6750 names no error code.
    ["Basic YWxpY2U6c2VjcmV0", `Bearer scope="read", resource_metadata="${metadata}"`],
    ["Bearer", `Bearer scope="read", resource_metadata="${metadata}"`],
  ])(
    "names invalid_token only for a bearer token presented: %s",
    async (authorization, challenge) => {
      const response = await web(new Action.Unauthenticated()).handler(request(authorization));

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe(challenge);
    },
  );

  it("refuses a required scope that is no OAuth scope token", () => {
    const bad = { ...resource, scopesRequired: ["has space"] as const };

    expect(() => Authentication.layer(Login, verify, { protectedResource: bad })).toThrow(
      'Invalid scope in scopesRequired: "has space"',
    );
  });

  it("leaves a request whose URL does not parse to the host, not a 500", async () => {
    const response = await web(new Action.Unauthenticated()).handler(
      new Request("http://localhost//[x/y"),
    );

    expect(response.status).toBe(404);
  });
});

describe("Authentication.protect", () => {
  const protectedResource = {
    resource: "https://api.example.com/api",
    authorizationServers: ["https://auth.example.com"],
    scopesRequired: ["docs:read"],
  } satisfies Authentication.ProtectedResource;

  const metadata = "https://api.example.com/.well-known/oauth-protected-resource/api";

  // A host's own routes beside an action, under the action's descriptor: one reads the
  // identity, one states its own caching, and the rest refuse or answer 401 themselves.
  const deployment = (
    verifier: Authentication.Verify<{ readonly id: string }, typeof Login.security, never> = verify,
  ) =>
    serve(
      Layer.mergeAll(
        ActionHttp.layer(IdentifyHttp, identify),
        Layer.mergeAll(
          HttpRouter.add(
            "GET",
            "/own",
            Effect.map(Identity, ({ id }) => HttpServerResponse.text(id)),
          ),
          HttpRouter.add(
            "GET",
            "/cached",
            Effect.succeed(
              HttpServerResponse.text("cached", { headers: { "cache-control": "private" } }),
            ),
          ),
          HttpRouter.add("GET", "/expired", Effect.fail(new Action.Unauthenticated())),
          HttpRouter.add(
            "GET",
            "/narrow",
            Effect.fail(
              new Action.Forbidden({ message: "Needs docs:write.", scopes: ["docs:write"] }),
            ),
          ),
          HttpRouter.add(
            "GET",
            "/signed-out",
            Effect.succeed(HttpServerResponse.text("Sign in again", { status: 401 })),
          ),
        ).pipe(Layer.provide(Authentication.protect(Login).layer)),
      ).pipe(Layer.provide(Authentication.layer(Login, verifier, { protectedResource }))),
    );

  const get = (path: string, authorization?: string) =>
    new Request(`http://localhost${path}`, {
      headers: authorization === undefined ? {} : { authorization },
    });

  const answerOf = async (response: Response) => [
    response.status,
    response.headers.get("www-authenticate"),
    response.headers.get("cache-control"),
    await response.text(),
  ];

  it("refuses a credential as the action routes refuse it", async () => {
    const web = deployment();

    for (const authorization of [undefined, "Bearer ", "Basic YWxpY2U6c2VjcmV0", "Bearer denied"]) {
      expect(await answerOf(await web.handler(get("/own", authorization)))).toEqual(
        await answerOf(await web.handler(request(authorization))),
      );
    }
  });

  it("gives the route the identity, and no-stores its answer unless it states its own caching", async () => {
    const web = deployment();

    const own = await web.handler(get("/own", "Bearer alice"));
    expect([own.status, own.headers.get("cache-control"), await own.text()]).toEqual([
      200,
      "no-store",
      "alice",
    ]);

    const cached = await web.handler(get("/cached", "Bearer alice"));
    expect(cached.headers.get("cache-control")).toBe("private");
  });

  it("answers the route's refusals as an action's, stepping up under Bearer, and challenges its own 401", async () => {
    const web = deployment();

    const expired = await web.handler(get("/expired", "Bearer alice"));
    expect([expired.status, expired.headers.get("www-authenticate")]).toEqual([
      401,
      `Bearer error="invalid_token", scope="docs:read", resource_metadata="${metadata}"`,
    ]);
    expect(Schema.decodeUnknownSync(Action.Unauthenticated)(await expired.json())).toBeInstanceOf(
      Action.Unauthenticated,
    );

    const narrow = await web.handler(get("/narrow", "Bearer alice"));
    expect([narrow.status, narrow.headers.get("www-authenticate")]).toEqual([
      403,
      `Bearer error="insufficient_scope", scope="docs:write", resource_metadata="${metadata}", error_description="Needs docs:write."`,
    ]);
    expect(narrow.headers.get("cache-control")).toBe("no-store");

    const signedOut = await web.handler(get("/signed-out", "Bearer alice"));
    expect([signedOut.status, signedOut.headers.get("www-authenticate")]).toEqual([
      401,
      `Bearer error="invalid_token", scope="docs:read", resource_metadata="${metadata}"`,
    ]);
  });

  it("sends a verifier's own response, such as an unavailable issuer's", async () => {
    const web = deployment(() =>
      Effect.fail(HttpServerResponse.text("Issuer unavailable", { status: 503 })),
    );

    const own = await web.handler(get("/own", "Bearer alice"));
    expect([own.status, await own.text()]).toEqual([503, "Issuer unavailable"]);
  });

  it("authenticates under another scheme, as its actions are", async () => {
    const Session = Authentication.make("test.ProtectSession", Identity, {
      security: HttpApiSecurity.apiKey({ in: "cookie", key: "session" }),
    });

    const web = serve(
      Layer.mergeAll(
        ActionHttp.layer(ActionHttp.make([Identify], { authentication: Session }), identify),
        HttpRouter.add(
          "GET",
          "/own",
          Effect.map(Identity, ({ id }) => HttpServerResponse.text(id)),
        ).pipe(Layer.provide(Authentication.protect(Session).layer)),
      ).pipe(
        Layer.provide(
          Authentication.layer(Session, (session) =>
            Redacted.value(session) === "s1"
              ? Effect.succeed({ id: "alice" })
              : Effect.fail(new Action.Unauthenticated()),
          ),
        ),
      ),
    );

    const signedIn = get("/own");
    signedIn.headers.set("cookie", "session=s1");
    expect(await (await web.handler(signedIn)).text()).toBe("alice");

    const anonymous = await web.handler(get("/own"));
    const action = await web.handler(post("/api/identify"));
    expect(await answerOf(anonymous)).toEqual(await answerOf(action));
  });
});

describe("a scheme other than Bearer", () => {
  const Session = Authentication.make("test.Session", Identity, {
    security: HttpApiSecurity.apiKey({ in: "cookie", key: "session" }),
  });

  const verified: Array<string> = [];

  const sessions = Authentication.layer(Session, (session) => {
    verified.push(Redacted.value(session));

    if (Redacted.value(session) === "s1") return Effect.succeed({ id: "alice" });

    if (Redacted.value(session) === "narrow") {
      return Effect.fail(new Action.Forbidden({ scopes: ["write"] }));
    }

    return Effect.fail(new Action.Unauthenticated());
  });

  const deployment = () =>
    serve(
      Layer.mergeAll(
        ActionHttp.layer(ActionHttp.make([Identify], { authentication: Session }), identify),
        ActionMcp.layerHttp(identify, { name: "test", version: "0", authentication: Session }),
      ).pipe(Layer.provide(sessions)),
    );

  const withSession = (request: Request, session: string) => {
    request.headers.set("cookie", `session=${session}`);

    return request;
  };

  it("verifies the credential its scheme decodes, over HTTP and MCP, and challenges no 401 with Bearer", async () => {
    const web = deployment();
    const ok = await web.handler(withSession(post("/api/identify"), "s1"));
    expect([ok.status, await ok.json()]).toEqual([200, "alice"]);

    const tool = await web.handler(withSession(rawToolCall("identify"), "s1"));
    expect(await tool.json()).toMatchObject({ result: { structuredContent: "alice" } });

    for (const refused of [
      await web.handler(post("/api/identify")),
      await web.handler(withSession(post("/api/identify"), "stale")),
      await web.handler(rawToolCall("identify")),
    ]) {
      expect([refused.status, refused.headers.get("www-authenticate")]).toEqual([401, null]);
      expect(refused.headers.get("cache-control")).toBe("no-store");
    }

    // A cookie that is absent never reaches the verifier.
    expect(verified).toEqual(["s1", "s1", "stale"]);
  });

  it("challenges no refusal with Bearer, and steps no tool's call up", async () => {
    const web = deployment();

    const narrow = await web.handler(withSession(post("/api/identify"), "narrow"));
    expect([narrow.status, narrow.headers.get("www-authenticate")]).toEqual([403, null]);

    // A tool's refusal is its result, as on an endpoint no OAuth client signs in to.
    const Locked = Action.make("locked", { description: "", readOnly: false, caller: Identity });

    const locked = serve(
      ActionMcp.layerHttp(
        Action.implement(Locked, () => Effect.void, {
          authorize: () => Effect.fail(new Action.Forbidden({ scopes: ["write"] })),
        }),
        { name: "test", version: "0", authentication: Session },
      ).pipe(Layer.provide(sessions)),
    );

    const refused = await locked.handler(withSession(rawToolCall("locked"), "s1"));
    expect([refused.status, refused.headers.get("www-authenticate")]).toEqual([200, null]);
    expect(await refused.json()).toMatchObject({ result: { isError: true } });
  });

  it("refuses a protected resource, which only a Bearer scheme publishes", () => {
    expect(() =>
      Authentication.layer(Session, () => Effect.succeed({ id: "alice" }), {
        // @ts-expect-error A cookie names no OAuth resource.
        protectedResource: { resource: "https://a.example", authorizationServers: ["https://as"] },
      }),
    ).toThrow("A protected resource is published only for a Bearer scheme");
  });
});

describe("Basic", () => {
  const Basic = Authentication.make("test.Basic", Identity, { security: HttpApiSecurity.basic });

  const basic = Authentication.layer(Basic, ({ username, password }) =>
    username === "" && Redacted.value(password) === "token"
      ? Effect.succeed({ id: "service" })
      : Effect.fail(new Action.Unauthenticated()),
  );

  it("verifies a token sent as the password, and challenges with its realm", async () => {
    const web = serve(
      ActionHttp.layer(ActionHttp.make([Identify], { authentication: Basic }), identify).pipe(
        Layer.provide(basic),
      ),
    );

    const token = await web.handler(request(`Basic ${btoa(":token")}`));
    expect([token.status, await token.json()]).toEqual([200, "service"]);

    const anonymous = await web.handler(request());
    expect([anonymous.status, anonymous.headers.get("www-authenticate")]).toEqual([
      401,
      'Basic realm="test.Basic"',
    ]);
  });

  it("answers a host route's refusal as its routes do, through refusal", async () => {
    const web = serve(
      ActionHttp.layer(ActionHttp.make([Identify], { authentication: Basic }), identify).pipe(
        Layer.provide(basic),
      ),
    );

    const route = await web.handler(request());

    for (const error of [new Action.Unauthenticated(), new Action.Forbidden({ scopes: ["a"] })]) {
      const own = Authentication.refusal(error, { authentication: Basic });

      expect(own.headers["www-authenticate"]).toBe(
        Predicate.isTagged(error, "Unauthenticated")
          ? route.headers.get("www-authenticate")
          : undefined,
      );
      expect(own.headers["cache-control"]).toBe("no-store");
    }
  });
});

describe("a public action beside protected ones", () => {
  const Ping = Action.make("ping", {
    description: "Answer anyone",
    readOnly: true,
    caller: Action.Anyone,
    success: Schema.String,
  });

  const mixed = Action.implement(
    [Ping, Identify],
    { ping: () => Effect.succeed("pong"), identify: () => Effect.map(Identity, ({ id }) => id) },
    { authorize: Action.allowAll },
  );

  it("ignores any credential over HTTP, never verifying it", async () => {
    const seen: Array<unknown> = [];

    const web = serve(
      ActionHttp.layer(ActionHttp.make([Ping, Identify], { authentication: Login }), mixed).pipe(
        Layer.provide(
          Authentication.layer(Login, (token) => {
            seen.push(Redacted.value(token));

            return Effect.fail(new Action.Unauthenticated());
          }),
        ),
      ),
    );

    for (const authorization of [undefined, "Bearer forged", "Bearer", "Basic garbage"]) {
      const sent = post("/api/ping");

      if (authorization !== undefined) sent.headers.set("authorization", authorization);

      const response = await web.handler(sent);
      expect([response.status, await response.json()]).toEqual([200, "pong"]);
    }

    expect(seen).toEqual([]);
  });

  /**
   * One MCP endpoint of `ping` and `identify`, whose verifier accepts the secret `s1` as alice,
   * and the secrets it was given: a call presenting none, or an empty one, passes signed out,
   * and one presenting another is refused.
   */
  const presents = async (
    web: ReturnType<typeof serve>,
    seen: Array<string>,
    present: (request: Request, secret: string) => void,
  ) => {
    const withSecret = (request: Request, secret: string) => (present(request, secret), request);

    expect(await valueOf(await web.handler(rawToolCall("ping")))).toBe("pong");
    expect(await valueOf(await web.handler(withSecret(rawToolCall("ping"), "")))).toBe("pong");
    expect((await web.handler(withSecret(rawToolCall("ping"), "stale"))).status).toBe(401);
    expect(await valueOf(await web.handler(withSecret(rawToolCall("identify"), "s1")))).toBe(
      "alice",
    );
    expect(seen).toEqual(["stale", "s1"]);
  };

  /** Alice for the secret `s1`, recording each secret it is given. */
  const verifier = (seen: Array<string>) => (secret: string) => {
    seen.push(secret);

    return secret === "s1"
      ? Effect.succeed({ id: "alice" })
      : Effect.fail(new Action.Unauthenticated());
  };

  it("verifies a public MCP call's cookie only when it presents one", async () => {
    const Cookie = Authentication.make("test.Cookie", Identity, {
      security: HttpApiSecurity.apiKey({ in: "cookie", key: "session" }),
    });

    const seen: Array<string> = [];
    const verify = verifier(seen);

    const web = serve(
      ActionMcp.layerHttp(mixed, { name: "test", version: "0", authentication: Cookie }).pipe(
        Layer.provide(Authentication.layer(Cookie, (session) => verify(Redacted.value(session)))),
      ),
    );

    await presents(web, seen, (request, secret) =>
      request.headers.set("cookie", `session=${secret}`),
    );
  });

  it("verifies a public MCP call's Basic credentials only when it presents some", async () => {
    const Basic = Authentication.make("test.Basic", Identity, {
      security: HttpApiSecurity.basic,
    });

    const seen: Array<string> = [];
    const verify = verifier(seen);

    const web = serve(
      ActionMcp.layerHttp(mixed, { name: "test", version: "0", authentication: Basic }).pipe(
        Layer.provide(
          Authentication.layer(Basic, ({ password }) => verify(Redacted.value(password))),
        ),
      ),
    );

    await presents(web, seen, (request, secret) =>
      request.headers.set(
        "authorization",
        secret === "" ? "Basic " : `Basic ${btoa(`:${secret}`)}`,
      ),
    );
  });
});

describe("an empty credential", () => {
  it("never reaches the verifier, which would accept anything", async () => {
    const seen: Array<string> = [];

    const web = serve(
      ActionHttp.layer(IdentifyHttp, identify).pipe(
        Layer.provide(
          Authentication.layer(Login, (token) =>
            Effect.sync(() => {
              seen.push(Redacted.value(token));

              return { id: "anyone" };
            }),
          ),
        ),
      ),
    );

    for (const header of ["Bearer", "Bearer ", "Basic x"]) {
      const refused = await web.handler(request(header));

      expect([header, refused.status]).toEqual([header, 401]);
    }

    expect(seen).toEqual([]);
  });
});

describe("authentication around a surface", () => {
  const Public = Action.make("public", {
    description: "Answer anyone",
    readOnly: true,
    caller: Action.Anyone,
    success: Schema.String,
  });

  const Secret = Action.make("secret", {
    description: "Answer the authenticated identity",
    readOnly: true,
    caller: Identity,
    input: { note: Schema.String },
    success: Schema.String,
  });

  const Http = ActionHttp.make([Public, Secret], { authentication: Login });

  const open = Action.implement(Public, () => Effect.succeed("anyone"));

  const guarded = Action.implement(
    Secret,
    ({ note }) => Effect.map(Identity, ({ id }) => `${id}: ${note}`),
    { authorize: Action.allowAll },
  );

  const call = (path: string, body: Schema.Json, token?: string) => {
    const sent = post(`/api/${path}`, body);

    return token === undefined ? sent : withBearer(sent, token);
  };

  it.effect("builds its verifier once, on every surface it covers", () =>
    Effect.gen(function* () {
      let built = 0;

      const prefixed = Authentication.layer(
        Login,
        Effect.gen(function* () {
          built++;

          const { prefix } = yield* Tokens;

          return (token: Redacted.Redacted<string>) =>
            Effect.succeed({ id: `${prefix}${Redacted.value(token)}` });
        }),
      );

      // What its build yields is a startup requirement of the layers it covers, not of each
      // request; the request is the router's.
      expectTypeOf<Layer.Services<typeof prefixed>>().toEqualTypeOf<
        HttpRouter.HttpRouter | Tokens
      >();

      const routes = Layer.mergeAll(
        ActionHttp.layer(Http, guarded),
        ActionMcp.layerHttp(guarded, { name: "test", version: "0", authentication: Login }),
      ).pipe(
        Layer.provide(prefixed.pipe(Layer.provide(Layer.succeed(Tokens, { prefix: "actor:" })))),
      );

      yield* Effect.gen(function* () {
        const response = yield* send(call("secret", { note: "hi" }, "alice"));

        expect(yield* response.json).toBe("actor:alice: hi");

        const mcp = yield* Testing.mcpClient([Secret], as("alice"));

        expect(yield* mcp.secret({ note: "hi" })).toBe("actor:alice: hi");
      }).pipe(Effect.provide(Testing.layer(routes)));

      expect(built).toBe(1);
    }),
  );

  it("authenticates only the protected actions of a layer, so one layer serves public and private ones", async () => {
    const web = serve(ActionHttp.layer(Http, [open, guarded]).pipe(Layer.provide(authenticate)));

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

  it("marks an MCP endpoint's answer no-store only where it authenticates the request", async () => {
    const web = serve(
      ActionMcp.layerHttp([open, guarded], {
        name: "test",
        version: "0",
        authentication: Login,
      }).pipe(Layer.provide(authenticate)),
    );

    // Its listing and a public tool's call without a credential read none, as a public route.
    for (const sent of [mcpRequest({ method: "tools/list" }), rawToolCall("public")]) {
      const anyone = await web.handler(sent);
      expect(anyone.status).toBe(200);
      expect(anyone.headers.has("cache-control")).toBe(false);
    }

    const signedIn = await web.handler(withBearer(rawToolCall("secret", { note: "hi" }), "alice"));
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("cache-control")).toBe("no-store");
  });

  it("runs before decoding, so an unauthenticated caller learns nothing of the input", async () => {
    let calls = 0;

    const counted = Action.implement(Secret, ({ note }) => Effect.sync(() => (calls++, note)), {
      authorize: Action.allowAll,
    });

    const web = serve(ActionHttp.layer(Http, counted).pipe(Layer.provide(authenticate)));

    /** The secret's request, its body `body` and its content type `type`. */
    const raw = (body: string, type?: string) =>
      new Request("http://localhost/api/secret", {
        method: "POST",
        headers: type === undefined ? {} : { "content-type": type },
        body,
      });

    // Malformed JSON, an invalid input, and no content type: each refused unauthenticated.
    for (const sent of [
      raw("{", "application/json"),
      call("secret", { note: 42 }),
      raw('{"note":"hi"}'),
    ]) {
      const response = await web.handler(sent);

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
    }

    // Authenticated, each is decoding's.
    expect((await web.handler(withBearer(raw("{", "application/json"), "alice"))).status).toBe(400);
    expect((await web.handler(call("secret", { note: 42 }, "alice"))).status).toBe(400);
    expect((await web.handler(withBearer(raw('{"note":"hi"}'), "alice"))).status).toBe(415);
    expect(calls).toBe(0);
  });

  it("is what the binding documents: each protected operation's security, from its contract", () => {
    class RateLimited extends Schema.TaggedError<RateLimited>()(
      "RateLimited",
      { retryAfter: Schema.Finite },
      { httpApiStatus: 429 },
    ) {}

    class Limited extends Action.Check<Limited>()("test/Limited", { error: RateLimited }) {}

    const Limit = Action.make("limit", {
      description: "Limited",
      readOnly: false,
      caller: Identity,
      checks: [Limited],
    });

    const example = OpenApi.fromApi(ExampleHttp.api);
    expect(example.paths["/api/status"]?.post?.security).toEqual([]);
    expect(example.paths["/api/renameUser"]?.post?.security).toEqual([{ "example.Login": [] }]);
    expect(example.paths["/api/double"]?.post?.security).toEqual([{ "example.Login": [] }]);
    expect(example.components.securitySchemes).toMatchObject({
      "example.Login": { type: "http", scheme: "Bearer" },
    });

    // A check's declared error is the operation's, as the action's own errors are.
    const limited = OpenApi.fromApi(
      ActionHttp.make([Public, Limit], { authentication: Login }).api,
    );

    expect(limited.paths["/api/limit"]?.post?.responses).toHaveProperty("429");
    expect(limited.paths["/api/public"]?.post?.responses).not.toHaveProperty("429");
  });

  it.effect("authenticates every request to an endpoint of protected tools alone", () =>
    Effect.gen(function* () {
      const anonymous = yield* Testing.mcpClient([Secret]);
      expect(yield* Effect.flip(anonymous.secret({ note: "hi" }))).toBeInstanceOf(
        Action.Unauthenticated,
      );

      // Even a body no server reads: it is refused before it is decoded.
      const malformed = yield* send(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
      );

      expect(malformed.status).toBe(401);

      const alice = yield* Testing.mcpClient([Secret], as("alice"));

      expect(yield* alice.secret({ note: "hi" })).toBe("alice: hi");
    }).pipe(
      Effect.provide(
        Testing.layer(
          ActionMcp.layerHttp(guarded, { name: "test", version: "0", authentication: Login }).pipe(
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

describe("Authentication.layer beside other middleware", () => {
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

  /** The host's own router middleware: each request's tenant, from its `x-tenant` header. */
  const resolveTenant = HttpRouter.middleware<{ provides: Tenant }>()((route) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      Effect.provideService(route, Tenant, request.headers["x-tenant"] ?? "none"),
    ),
  );

  /** A handler-style builder: the verifier at startup, the tenant and token per request. */
  const build = Effect.gen(function* () {
    const { verify: check } = yield* Verifier;

    return (token: Redacted.Redacted<string>) =>
      Effect.flatMap(Tenant, (tenant) => check(tenant, Redacted.value(token)));
  });

  const authentication = Authentication.layer(Login, build, { protectedResource: resource });

  const WhoAmI = Action.make("whoAmI", {
    description: "Name the authenticated caller",
    readOnly: true,
    caller: Identity,
    success: Schema.String,
  });

  const Http = ActionHttp.make([WhoAmI], { authentication: Login });

  /** A tenant marked `locked` needs the `admin` scope: the authorizer's step-up refusal. */
  const whoAmI = Action.implement(WhoAmI, () => Effect.map(Identity, ({ id }) => id), {
    authorize: () =>
      Effect.flatMap(Identity, ({ id }) =>
        id.endsWith("@locked")
          ? Effect.fail(new Action.Forbidden({ scopes: ["admin"] }))
          : Effect.void,
      ),
  });

  /** The layer's own middleware reading the identity: marks each response with its caller. */
  class AccessLog extends HttpApiMiddleware.Service<AccessLog, { requires: Identity }>()(
    "test/AccessLog",
  ) {}

  const accessLog = Layer.succeed(AccessLog, (route) =>
    Effect.flatMap(Identity, ({ id }) =>
      Effect.map(route, HttpServerResponse.setHeader("x-caller", id)),
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

  it.effect(
    "reads a request service from router middleware provided after it, over HTTP and MCP",
    () =>
      Effect.gen(function* () {
        const acme = yield* send(call({ authorization: "Bearer alice", "x-tenant": "acme" }));
        const globex = yield* send(call({ authorization: "Bearer bob", "x-tenant": "globex" }));
        expect([yield* acme.json, yield* globex.json]).toEqual(["alice@acme", "bob@globex"]);

        expect(yield* mcpCall({ authorization: "Bearer carol", "x-tenant": "initech" })).toBe(
          "carol@initech",
        );

        // Its refusals and challenges are the same beside it.
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

        // An authorizer's step-up refusal answers the request, over HTTP and over MCP.
        const locked = yield* send(call({ authorization: "Bearer alice", "x-tenant": "locked" }));
        expect([locked.status, locked.headers["www-authenticate"]]).toEqual([403, stepUp]);

        const tool = mcpRequest({
          method: "tools/call",
          params: { name: "whoAmI", arguments: {} },
        });

        tool.headers.set("authorization", "Bearer alice");
        tool.headers.set("x-tenant", "locked");
        const lockedTool = yield* send(tool);
        expect([lockedTool.status, lockedTool.headers["www-authenticate"]]).toEqual([403, stepUp]);
      }).pipe(
        Effect.provide(
          Testing.layer(
            // The verifier's request Tenant is discharged only by a later provide: in one
            // array with the authentication, it would stay owed (middleware-types.spec.ts).
            Layer.mergeAll(
              ActionHttp.layer(Http, whoAmI),
              ActionMcp.layerHttp(whoAmI, { name: "test", version: "0", authentication: Login }),
            ).pipe(
              Layer.provide(authentication),
              Layer.provide(verifiers().layer),
              Layer.provide(resolveTenant.layer),
            ),
          ),
        ),
      ),
  );

  it.effect("builds once however many layers it is provided to, whatever middleware they run", () =>
    Effect.gen(function* () {
      const { builds, layer } = verifiers();
      const runs = { count: 0 };

      // The same authentication, counting the runs of its builder.
      const counted = Authentication.layer(
        Login,
        Effect.andThen(
          Effect.sync(() => runs.count++),
          build,
        ),
        { protectedResource: resource },
      );

      const routes = Layer.mergeAll(
        ActionHttp.layer(Http, whoAmI, { middleware: [AccessLog] }),
        ActionMcp.layerHttp(whoAmI, { name: "test", version: "0", authentication: Login }),
        ActionMcp.layerHttp(whoAmI, {
          name: "test",
          version: "0",
          path: "/other",
          authentication: Login,
        }),
      ).pipe(
        Layer.provide([counted, accessLog]),
        Layer.provide(layer),
        Layer.provide(resolveTenant.layer),
      );

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

  it.effect("serves the documented tenant example", () =>
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
      for (const [host, token] of [
        ["acme.example.com", "bob"],
        ["globex.example.com", "alice"],
      ] as const) {
        const outsider = yield* whoAmIAt(host, token);
        expect([outsider.status, outsider.headers["x-actor"]]).toEqual([403, undefined]);
        expect(yield* outsider.json).toMatchObject({ message: "Not a member of this tenant." });
      }

      const anonymous = yield* whoAmIAt("acme.example.com");
      expect([
        anonymous.status,
        anonymous.headers["www-authenticate"],
        anonymous.headers["x-actor"],
      ]).toEqual([401, "Bearer", undefined]);

      const bob = yield* whoAmIAt("other.example.com", "bob");
      expect([bob.status, bob.headers["x-actor"], yield* bob.json]).toEqual([
        200,
        "bob",
        { id: "bob", tenantId: "other" },
      ]);
    }).pipe(Effect.provide(Testing.layer(tenantRoutes.pipe(Layer.provide(Users.layerMemory))))),
  );

  it("refuses a foreign Host or Origin under the example's global policy before the tenant example's authentication", async () => {
    const web = serve(
      Layer.mergeAll(requestPolicy, tenantRoutes).pipe(Layer.provide(Users.layerMemory)),
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

    // Refused before routing: nothing read a credential, so no 401.
    expect(await answer("http://evil.example/api/whoAmI")).toEqual([403, null, "Host not allowed"]);
    expect(
      await answer("http://evil.example/api/whoAmI", { authorization: "Bearer forged" }),
    ).toEqual([403, null, "Host not allowed"]);
    expect(await answer("http://localhost/api/whoAmI", { origin: "https://evil.example" })).toEqual(
      [403, null, "Origin not allowed"],
    );

    // What the policy lets through, the authentication answers.
    expect((await answer("http://localhost/api/whoAmI")).slice(0, 2)).toEqual([401, "Bearer"]);
  });

  /** What the Host check below saw of the tenant, once per request it refused. */
  const seen: Array<string> = [];

  /** A Host check, router middleware: refuses a foreign Host, noting the tenant resolved by then. */
  const hostCheck = HttpRouter.middleware()((route) =>
    Effect.gen(function* () {
      const sent = yield* HttpServerRequest.HttpServerRequest;
      const url = HttpServerRequest.toURL(sent.modify({ url: sent.originalUrl }));

      if (Option.isSome(url) && url.value.hostname === "api.example.com") return yield* route;

      seen.push(Option.getOrElse(yield* Effect.serviceOption(Tenant), () => "no tenant"));

      return HttpServerResponse.text("Host not allowed", { status: 403 });
    }),
  );

  it.each([
    [
      "alone",
      () =>
        serve(
          ActionHttp.layer(Http, whoAmI).pipe(
            Layer.provide(authenticate),
            Layer.provide(hostCheck.layer),
          ),
        ),
      ["no tenant"],
    ],
    [
      "beneath the router middleware feeding the verifier",
      () =>
        serve(
          ActionHttp.layer(Http, whoAmI).pipe(
            Layer.provide(authentication),
            Layer.provide(hostCheck.layer),
            Layer.provide(verifiers().layer),
            Layer.provide(resolveTenant.layer),
          ),
        ),
      ["acme"],
    ],
    [
      "around the layer's middleware reading the identity",
      () =>
        serve(
          ActionHttp.layer(Http, whoAmI, { middleware: [AccessLog] }).pipe(
            Layer.provide([authenticate, accessLog]),
            Layer.provide(hostCheck.layer),
          ),
        ),
      ["no tenant"],
    ],
  ])(
    "runs a Host check provided around routes before their authentication: %s",
    async (_, web, refused) => {
      seen.length = 0;

      const response = await web().handler(
        new Request("https://evil.example/api/whoAmI", {
          method: "POST",
          headers: { "content-type": "application/json", "x-tenant": "acme" },
          body: "{}",
        }),
      );

      // A 403, the Host check's, run before the authentication, which would answer 401.
      expect([response.status, response.headers.get("x-caller"), seen]).toEqual([
        403,
        null,
        refused,
      ]);
    },
  );
});

describe("one MCP URL for signed-out and signed-in callers", () => {
  const issuer = "https://auth.example.com";

  /**
   * The documented example's endpoint, behind an OAuth authorization server in memory that
   * issues `alice`'s token for a write scope and `reader`'s otherwise, logging what each
   * side is asked.
   */
  const deployment = () => {
    const web = serve(app);
    const log: string[] = [];

    const authorizationServer = async (sent: Request): Promise<Response> => {
      const { pathname } = new URL(sent.url);

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

      const form = new URLSearchParams(await sent.text());
      const scope = form.get("scope") ?? "";

      log.push(`token ${scope} for ${form.get("resource")}`);

      return Response.json({
        access_token: scope.split(" ").includes("users:write") ? "alice" : "reader",
        token_type: "Bearer",
        expires_in: 3600,
        scope,
      });
    };

    const fetch = async (sent: Request): Promise<Response> => {
      if (sent.url.startsWith(issuer)) return authorizationServer(sent);

      const response = await web.handler(sent);
      const called = sent.headers.get("mcp-name") ?? sent.headers.get("mcp-method");

      log.push(
        `${called ?? new URL(sent.url).pathname} ${sent.headers.get("authorization") ?? "signed out"}: ${response.status}`,
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
      const status = await client.callTool({ name: "status", arguments: {} });

      const renamed = await client.callTool({
        name: "renameUser",
        arguments: { id: "1", name: "OAuth" },
      });

      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "status",
        "getUser",
        "renameUser",
        "whoAmI",
        "listChanges",
        "double",
      ]);
      expect(status.structuredContent).toEqual({ service: "effect-actions", users: 2 });
      expect(renamed.structuredContent).toEqual({ id: "1", name: "OAuth" });
    } finally {
      await client.close();
    }

    // Signed out, the listing and the public tool answer; the protected one answers 401, on
    // which the client signs in for the scope it names, then the authorizer's 403 naming the
    // scope a write needs, on which it steps up. Each token is requested for this resource.
    expect(log).toEqual([
      "server/discover signed out: 200",
      "tools/list signed out: 200",
      "status signed out: 200",
      "renameUser signed out: 401",
      "/.well-known/oauth-protected-resource/mcp signed out: 200",
      "token users:read for http://localhost:3000/mcp",
      "renameUser Bearer reader: 403",
      "/.well-known/oauth-protected-resource/mcp signed out: 200",
      "token users:read users:write for http://localhost:3000/mcp",
      "renameUser Bearer alice: 200",
    ]);
  });
});
