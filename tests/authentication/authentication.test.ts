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

import * as Authentication from "../../src/authentication/Authentication.js";
import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as Testing from "../../src/testing/Testing.js";
import * as ActionToolkit from "../../src/toolkit/ActionToolkit.js";
import { routes as tenantRoutes } from "../support/app/authentication-tenant.js";
import {
  protectedResource as exampleProtectedResource,
  verify as exampleVerify,
} from "../support/app/authentication.js";
import {
  Http as ExampleHttp,
  Login as ExampleLogin,
} from "../support/app/binding.js";
import { endpoint as exampleMcp } from "../support/app/mcp.js";
import { requestPolicy } from "../support/app/request-policy.js";
import { Users } from "../support/app/users.js";
import {
  as,
  mcpRequest,
  post,
  rawToolCall,
  send,
  valueOf,
  withBearer,
} from "../support/requests.js";
import { serve } from "../support/serve.js";

class Identity extends Context.Service<Identity, { readonly id: string }>()(
  "test/Identity"
) {}

class Tokens extends Context.Service<Tokens, { readonly prefix: string }>()(
  "test/Tokens"
) {}

class Private extends Schema.TaggedError<
  Private,
  { readonly brand: unique symbol }
>()("Private", {
  message: Schema.String,
}) {}

const Login = Authentication.make("test.Login", Identity);

class Unavailable extends Schema.TaggedError<
  Unavailable,
  { readonly brand: unique symbol }
>()(
  "Unavailable",
  { operation: Schema.String, retryAfter: Schema.FiniteFromString },
  { httpApiStatus: 503 }
) {}

class Expired extends Schema.TaggedError<
  Expired,
  { readonly brand: unique symbol }
>()("Expired", {}, { httpApiStatus: 401 }) {}

const Checked = Authentication.make("test.Checked", Identity, {
  error: [Unavailable, Expired],
});

const Identify = Action.make("identify", {
  description: "Name the authenticated caller",
  readOnly: true,
  caller: Identity,
  success: Schema.String,
});

const IdentifyHttp = ActionHttp.make([Identify], { authentication: Login });

const MismatchedCookie = Authentication.make(
  "test.MismatchedCookie",
  Identity,
  {
    security: HttpApiSecurity.apiKey({ in: "cookie", key: "__Secure-session" }),
  }
);

const identify = Action.implement(
  Identify,
  () => Effect.map(Identity, ({ id }) => id),
  {
    authorize: Action.allowAll,
  }
);

const request = (authorization?: string) => {
  const sent = post("/api/identify");

  if (authorization !== undefined) {
    sent.headers.set("authorization", authorization);
  }

  return sent;
};

const verify = (token: Redacted.Redacted) =>
  Redacted.value(token) === "denied"
    ? Effect.fail(new Action.Forbidden({ message: "Denied token" }))
    : Effect.succeed({ id: Redacted.value(token) });

const authenticate = Authentication.layer(Login, verify);

describe("Authentication.make", () => {
  it("refuses a name that is no OpenAPI component key, which the name becomes", () => {
    for (const name of ["app/Login", "app:Login", "Log in", ""]) {
      expect(() => Authentication.make(name, Identity)).toThrow(
        `Invalid authentication name: ${JSON.stringify(name)}, not an OpenAPI key: use only letters, digits, "_", "." and "-"`
      );
    }

    expect(Authentication.make("app.Login-2_x", Identity).name).toBe(
      "app.Login-2_x"
    );
  });

  it("refuses a security that is no native scheme, such as the record of schemes it once took", () => {
    for (const security of [{}, { bearer: HttpApiSecurity.bearer }, "Bearer"]) {
      expect(() =>
        // @ts-expect-error -- Plain JavaScript can pass anything.
        Authentication.make("test.Refused", Identity, { security })
      ).toThrow(
        "Authentication takes one native HttpApiSecurity scheme as `security`: omit it for Bearer, or give one scheme, such as `HttpApiSecurity.basic`, never a record of them"
      );
    }
  });
});

describe("a protected action's descriptor", () => {
  class Other extends Context.Service<Other, { readonly id: string }>()(
    "test/Other"
  ) {}

  const OtherLogin = Authentication.make("test.OtherLogin", Other);

  const refused =
    "Protected action 'identify' requires its matching authentication descriptor (give it the authentication whose identity the action's caller names)";

  it("is required, and of the identity the action declares, where plain JavaScript serves it", () => {
    for (const authentication of [undefined, OtherLogin]) {
      // @ts-expect-error -- The check exists for callers the compiler never sees.
      expect(() => ActionHttp.make([Identify], { authentication })).toThrow(
        refused
      );

      expect(() =>
        ActionMcp.layerHttp(identify, {
          name: "test",
          version: "0",
          // @ts-expect-error -- The check exists for callers the compiler never sees.
          authentication,
        })
      ).toThrow(refused);
    }

    const descriptorSwappedAfterMake = {
      ...IdentifyHttp,
      authentication: OtherLogin,
    };

    expect(() =>
      ActionHttp.layer(descriptorSwappedAfterMake, identify)
    ).toThrow(refused);
  });
});

const leaking: Authentication.Verify<
  { readonly id: string },
  typeof Login.security,
  never
> = () =>
  // @ts-expect-error -- Only a refusal or an error the descriptor declares may fail authentication; plain JavaScript can still fail with anything.
  Effect.fail(new Private({ message: "Undeclared" }));

describe("Authentication.layer", () => {
  it("dies building a provider given no verifier, as plain JavaScript may", async () => {
    // @ts-expect-error -- Without a verifier, the layer's request requirement is unknown.
    const missing: Layer.Layer<unknown, never, HttpRouter.HttpRouter> =
      Authentication.layer(
        Login,
        // @ts-expect-error -- The check exists for callers the compiler never sees.
        undefined
      );

    const exit = await Effect.runPromiseExit(
      Layer.build(missing).pipe(Effect.provide(HttpRouter.layer), Effect.scoped)
    );

    expect(String(exit)).toContain(
      "Missing verify: pass a verify function, or an Effect building one"
    );
  });

  it("answers a refusal as JSON before the action runs, and provides the identity otherwise", async () => {
    let calls = 0;

    const counted = Action.implement(
      Identify,
      () =>
        Effect.map(Identity, ({ id }) => {
          calls += 1;

          return id;
        }),
      { authorize: Action.allowAll }
    );

    const web = serve(
      ActionHttp.layer(IdentifyHttp, counted).pipe(Layer.provide(authenticate))
    );

    for (const [token, status] of [
      [undefined, 401],
      ["denied", 403],
    ] as const) {
      const response = await web.handler(
        token === undefined ? request() : withBearer(request(), token)
      );

      expect(response.status).toBe(status);
      expect(response.headers.get("content-type")).toContain(
        "application/json"
      );
    }

    expect(calls).toBe(0);

    const asAlice = await web.handler(withBearer(request(), "alice"));

    await expect(asAlice.json()).resolves.toBe("alice");

    const asBob = await web.handler(withBearer(request(), "bob"));

    await expect(asBob.json()).resolves.toBe("bob");
    expect(calls).toBe(2);
  });

  it("challenges every 401 it covers that has no challenge of its own", async () => {
    const Refuse = Action.make("refuse", {
      description: "Refused by its handler",
      readOnly: true,
      caller: Identity,
    });

    const own = Authentication.layer(Checked, (token: Redacted.Redacted) =>
      Redacted.value(token) === "expired"
        ? Effect.fail(new Expired())
        : Effect.succeed({ id: Redacted.value(token) })
    );

    const web = serve(
      ActionHttp.layer(
        ActionHttp.make([Refuse], { authentication: Checked }),
        Action.implement(
          Refuse,
          () => Effect.fail(new Action.Unauthenticated()),
          {
            authorize: Action.allowAll,
          }
        )
      ).pipe(Layer.provide(own))
    );

    const anonymous = await web.handler(post("/api/refuse"));

    const verifierOwn401 = await web.handler(
      withBearer(post("/api/refuse"), "expired")
    );

    const handlerOwn401 = await web.handler(
      withBearer(post("/api/refuse"), "alice")
    );

    expect([
      anonymous.status,
      verifierOwn401.status,
      handlerOwn401.status,
    ]).toStrictEqual([401, 401, 401]);
    expect(anonymous.headers.get("www-authenticate")).toBe("Bearer");
    expect(verifierOwn401.headers.get("www-authenticate")).toBe(
      'Bearer error="invalid_token"'
    );
    expect(handlerOwn401.headers.get("www-authenticate")).toBe(
      'Bearer error="invalid_token"'
    );
  });

  it("challenges an authorizer's 401 as its own, naming the scopes a first login requests", async () => {
    const Read = Action.make("read", {
      description: "Read",
      readOnly: true,
      caller: Identity,
    });

    const web = serve(
      ActionHttp.layer(
        ActionHttp.make([Read], { authentication: Login }),
        Action.implement(Read, () => Effect.void, {
          authorize: () => Effect.fail(new Action.Unauthenticated()),
        })
      ).pipe(
        Layer.provide(
          Authentication.layer(Login, verify, {
            protectedResource: {
              resource: "https://api.example.com/api",
              authorizationServers: ["https://auth.example.com"],
              scopesRequired: ["docs:read"],
            },
          })
        )
      )
    );

    const refused = await web.handler(withBearer(post("/api/read"), "alice"));

    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toBe(
      'Bearer error="invalid_token", scope="docs:read", resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/api"'
    );
  });

  it("challenges an authorizer's refusal naming scopes with insufficient_scope, describing it only in RFC 6750's characters", async () => {
    const Write = Action.make("write", {
      description: "Write",
      readOnly: false,
      caller: Identity,
    });

    const write = Action.implement(Write, () => Effect.void, {
      authorize: () =>
        Effect.fail(
          new Action.Forbidden({
            message: 'Needs "write".',
            scopes: ["a:write", "b"],
          })
        ),
    });

    const web = serve(
      ActionHttp.layer(
        ActionHttp.make([Write], { authentication: Login }),
        write
      ).pipe(
        Layer.provide(
          Authentication.layer(Login, verify, {
            protectedResource: {
              resource: "https://api.example.com/api",
              authorizationServers: ["https://auth.example.com"],
            },
          })
        )
      )
    );

    const refused = await web.handler(withBearer(post("/api/write"), "caller"));
    expect(refused.status).toBe(403);
    expect(refused.headers.get("www-authenticate")).toBe(
      'Bearer error="insufficient_scope", scope="a:write b", resource_metadata="https://api.example.com/.well-known/oauth-protected-resource/api"'
    );
  });

  it("refuses a scope that is no OAuth scope token", () => {
    expect(
      new Action.Forbidden({ scopes: ["users:write"] }).scopes
    ).toStrictEqual(["users:write"]);
    expect(() => new Action.Forbidden({ scopes: ["has space"] })).toThrow(
      "Schema validation failed"
    );
  });

  it("rejects any other failure in the types, and answers it with an empty 500", async () => {
    const web = serve(
      ActionHttp.layer(IdentifyHttp, identify).pipe(
        Layer.provide(Authentication.layer(Login, leaking))
      )
    );

    const response = await web.handler(withBearer(request(), "alice"));
    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toBe("");
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
        const releasing = yield* Deferred.make<undefined>();
        const allowRelease = yield* Deferred.make<undefined>();
        const released = yield* Deferred.make<undefined>();

        const acquiring = Authentication.layer(Login, () =>
          Effect.acquireRelease(
            Effect.sync(() => {
              events.push("acquire");

              return { id: "alice" };
            }),
            () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(releasing, undefined);

                const releasedAfterHandler = events.includes("handler");

                if (releasedAfterHandler) {
                  yield* Deferred.await(allowRelease);
                }

                events.push("release");
                yield* Deferred.succeed(released, undefined);
              })
          )
        );

        const reading = Action.implement(
          Identify,
          () =>
            Effect.gen(function* () {
              expect(events).toStrictEqual(["acquire"]);
              events.push("handler");
              const { id } = yield* Identity;

              return outcome === "returns"
                ? id
                : yield* Effect.die(new Error("handler failed"));
            }),
          { authorize: Action.allowAll }
        );

        const routes =
          transport === "an HTTP"
            ? ActionHttp.layer(IdentifyHttp, reading).pipe(
                Layer.provide(acquiring)
              )
            : ActionMcp.layerHttp(reading, {
                name: "scope-test",
                version: "0",
                authentication: Login,
              }).pipe(Layer.provide(acquiring));

        yield* Effect.gen(function* () {
          const response = yield* send(
            withBearer(
              transport === "an HTTP" ? request() : rawToolCall("identify"),
              "alice"
            )
          );

          expect(response.status).toBe(status);
          expect(response.headers["cache-control"]).toBe("no-store");
          expect((yield* response.text).includes("alice")).toBe(
            outcome === "returns"
          );
          yield* Deferred.await(releasing);
          expect(events).toStrictEqual(["acquire", "handler"]);
          yield* Deferred.succeed(allowRelease, undefined);
          yield* Deferred.await(released);
          expect(events).toStrictEqual(["acquire", "handler", "release"]);
        }).pipe(
          Effect.ensuring(Deferred.succeed(allowRelease, undefined)),
          Effect.provide(Testing.layer(routes))
        );
      })
  );

  it("never lets a protected action's failure be cached, even where enclosing middleware marks its response public", async () => {
    class Hidden extends Schema.TaggedError<
      Hidden,
      { readonly brand: unique symbol }
    >()("Hidden", { message: Schema.String }, { httpApiStatus: 404 }) {}

    const Find = Action.make("find", {
      description: "Find something private",
      readOnly: true,
      caller: Identity,
      error: [Hidden],
    });

    const find = Action.implement(
      Find,
      () =>
        Effect.flatMap(
          Identity,
          ({ id }) => new Hidden({ message: `private data for ${id}` })
        ),
      { authorize: Action.allowAll }
    );

    const hostMarkingPublicCacheable = HttpRouter.middleware()((route) =>
      Effect.map(
        route,
        HttpServerResponse.setHeader("cache-control", "public, max-age=60")
      )
    );

    const web = serve(
      ActionHttp.layer(
        ActionHttp.make([Find], { authentication: Login }),
        find
      ).pipe(
        Layer.provide(authenticate),
        Layer.provide(hostMarkingPublicCacheable.layer)
      )
    );

    const response = await web.handler(withBearer(post("/api/find"), "alice"));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      message: "private data for alice",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps the caching a route states, and no-stores every other response", async () => {
    const Artifact = Action.make("artifact", {
      description: "An immutable artifact of the caller's",
      readOnly: true,
      caller: Identity,
      success: Schema.String,
    });

    const Http = ActionHttp.make([Artifact, Identify], {
      authentication: Login,
    });

    class Immutable extends HttpApiMiddleware.Service<Immutable>()(
      "test/Immutable"
    ) {}

    const immutable = Layer.succeed(Immutable, (route) =>
      Effect.map(
        route,
        HttpServerResponse.setHeader(
          "cache-control",
          "private, max-age=31536000, immutable"
        )
      )
    );

    const artifact = Action.implement(
      Artifact,
      () => Effect.succeed("artifact"),
      {
        authorize: Action.allowAll,
      }
    );

    const web = serve(
      Layer.mergeAll(
        ActionHttp.layer(Http, artifact, { middleware: [Immutable] }).pipe(
          Layer.provide(immutable)
        ),
        ActionHttp.layer(Http, identify)
      ).pipe(Layer.provide(authenticate))
    );

    const stated = await web.handler(
      withBearer(post("/api/artifact"), "alice")
    );

    expect(stated.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable"
    );

    const response = await web.handler(withBearer(request(), "alice"));

    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("Authentication.layer's refusals", () => {
  const resource = {
    resource: "https://api.example.com/mcp",
    authorizationServers: ["https://auth.example.com"],
    scopesRequired: ["read"],
  } as const;

  const metadata =
    "https://api.example.com/.well-known/oauth-protected-resource/mcp";

  const web = (error: Action.Refusal) =>
    serve(
      ActionHttp.layer(IdentifyHttp, identify).pipe(
        Layer.provide(
          Authentication.layer(Login, () => Effect.fail(error), {
            protectedResource: resource,
          })
        )
      )
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
      await expect(response.json()).resolves.toStrictEqual(
        Schema.encodeSync(Action.Refusal)(error)
      );
    }
  );

  it.each([
    [undefined, `Bearer scope="read", resource_metadata="${metadata}"`],
    [
      "Bearer x",
      `Bearer error="invalid_token", scope="read", resource_metadata="${metadata}"`,
    ],
    [
      "Basic YWxpY2U6c2VjcmV0",
      `Bearer scope="read", resource_metadata="${metadata}"`,
    ],
    ["Bearer", `Bearer scope="read", resource_metadata="${metadata}"`],
  ])(
    "names invalid_token only for a bearer token presented: %s",
    async (authorization, challenge) => {
      const response = await web(new Action.Unauthenticated()).handler(
        request(authorization)
      );

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe(challenge);
    }
  );

  it("refuses a required scope that is no OAuth scope token", () => {
    const bad = { ...resource, scopesRequired: ["has space"] as const };

    expect(() =>
      Authentication.layer(Login, verify, { protectedResource: bad })
    ).toThrow(
      `Invalid scope in scopesRequired: "has space", not an OAuth scope token: give each scope as its own element, of printable ASCII without a space, '"' or '\\'`
    );
  });

  it("refuses a supported scope that is no OAuth scope token", () => {
    const bad = {
      ...resource,
      scopesSupported: ["docs:read", "has space"] as const,
    };

    expect(() =>
      Authentication.layer(Login, verify, { protectedResource: bad })
    ).toThrow(
      `Invalid scope in scopesSupported: "has space", not an OAuth scope token: give each scope as its own element, of printable ASCII without a space, '"' or '\\'`
    );
  });

  it("leaves a request whose URL does not parse to the host, not a 500", async () => {
    const response = await web(new Action.Unauthenticated()).handler(
      new Request("http://localhost//[x/y")
    );

    expect(response.status).toBe(404);
  });
});

const get = (path: string, authorization?: string) =>
  new Request(`http://localhost${path}`, {
    headers: authorization === undefined ? {} : { authorization },
  });

const textAnswerOf = async (response: Response) => [
  response.status,
  response.headers.get("www-authenticate"),
  response.headers.get("cache-control"),
  await response.text(),
];

describe("Authentication.protect", () => {
  const protectedResource = {
    resource: "https://api.example.com/api",
    authorizationServers: ["https://auth.example.com"],
    scopesRequired: ["docs:read"],
  } satisfies Authentication.ProtectedResource;

  const metadata =
    "https://api.example.com/.well-known/oauth-protected-resource/api";

  const hostRoutesBesideAnAction = (
    verifier: Authentication.Verify<
      { readonly id: string },
      typeof Login.security,
      never
    > = verify
  ) =>
    serve(
      Layer.mergeAll(
        ActionHttp.layer(IdentifyHttp, identify),
        Layer.mergeAll(
          HttpRouter.add(
            "GET",
            "/own",
            Effect.map(Identity, ({ id }) => HttpServerResponse.text(id))
          ),
          HttpRouter.add(
            "GET",
            "/cached",
            Effect.succeed(
              HttpServerResponse.text("cached", {
                headers: { "cache-control": "private" },
              })
            )
          ),
          HttpRouter.add(
            "GET",
            "/expired",
            Effect.fail(new Action.Unauthenticated())
          ),
          HttpRouter.add(
            "GET",
            "/narrow",
            Effect.fail(
              new Action.Forbidden({
                message: "Needs docs:write.",
                scopes: ["docs:write"],
              })
            )
          ),
          HttpRouter.add(
            "GET",
            "/signed-out",
            Effect.succeed(
              HttpServerResponse.text("Sign in again", { status: 401 })
            )
          )
        ).pipe(Layer.provide(Authentication.protect(Login).layer))
      ).pipe(
        Layer.provide(
          Authentication.layer(Login, verifier, { protectedResource })
        )
      )
    );

  it("refuses a credential as the action routes refuse it", async () => {
    const web = hostRoutesBesideAnAction();

    for (const authorization of [
      undefined,
      "Bearer ",
      "Basic YWxpY2U6c2VjcmV0",
      "Bearer denied",
    ]) {
      await expect(
        textAnswerOf(await web.handler(get("/own", authorization)))
      ).resolves.toStrictEqual(
        await textAnswerOf(await web.handler(request(authorization)))
      );
    }
  });

  it("gives the route the identity, and no-stores its answer unless it states its own caching", async () => {
    const web = hostRoutesBesideAnAction();

    const own = await web.handler(get("/own", "Bearer alice"));
    expect([
      own.status,
      own.headers.get("cache-control"),
      await own.text(),
    ]).toStrictEqual([200, "no-store", "alice"]);

    const cached = await web.handler(get("/cached", "Bearer alice"));
    expect(cached.headers.get("cache-control")).toBe("private");
  });

  it.effect(
    "no-stores a failure of the route that enclosing middleware answers, whatever caching it states",
    () => {
      class Gone extends Schema.TaggedError<
        Gone,
        { readonly brand: unique symbol }
      >()("Gone", {}) {}

      const answeringGoneCacheable = HttpRouter.middleware<{ handles: Gone }>()(
        (route) =>
          Effect.catch(route, (error) =>
            Schema.is(Gone)(error)
              ? Effect.succeed(
                  HttpServerResponse.text("gone", {
                    status: 410,
                    headers: { "cache-control": "public, max-age=60" },
                  })
                )
              : Effect.fail(error)
          )
      );

      const routes = HttpRouter.add(
        "GET",
        "/gone",
        Effect.fail(new Gone())
      ).pipe(
        Layer.provide(Authentication.protect(Login).layer),
        Layer.provide(answeringGoneCacheable.layer),
        Layer.provide(Authentication.layer(Login, verify))
      );

      return Effect.gen(function* () {
        const gone = yield* send(get("/gone", "Bearer alice"));
        expect([gone.status, gone.headers["cache-control"]]).toStrictEqual([
          410,
          "no-store",
        ]);
      }).pipe(Effect.provide(Testing.layer(routes)));
    }
  );

  it("answers the route's refusals as an action's, stepping up under Bearer, and challenges its own 401", async () => {
    const web = hostRoutesBesideAnAction();

    const expired = await web.handler(get("/expired", "Bearer alice"));
    expect([
      expired.status,
      expired.headers.get("www-authenticate"),
    ]).toStrictEqual([
      401,
      `Bearer error="invalid_token", scope="docs:read", resource_metadata="${metadata}"`,
    ]);
    expect(
      Schema.decodeUnknownSync(Action.Unauthenticated)(await expired.json())
    ).toBeInstanceOf(Action.Unauthenticated);

    const narrow = await web.handler(get("/narrow", "Bearer alice"));
    expect([
      narrow.status,
      narrow.headers.get("www-authenticate"),
    ]).toStrictEqual([
      403,
      `Bearer error="insufficient_scope", scope="docs:write", resource_metadata="${metadata}", error_description="Needs docs:write."`,
    ]);
    expect(narrow.headers.get("cache-control")).toBe("no-store");

    const signedOut = await web.handler(get("/signed-out", "Bearer alice"));
    expect([
      signedOut.status,
      signedOut.headers.get("www-authenticate"),
    ]).toStrictEqual([
      401,
      `Bearer error="invalid_token", scope="docs:read", resource_metadata="${metadata}"`,
    ]);
  });

  it("authenticates under another scheme, as its actions are", async () => {
    const Session = Authentication.make("test.ProtectSession", Identity, {
      security: HttpApiSecurity.apiKey({ in: "cookie", key: "session" }),
    });

    const web = serve(
      Layer.mergeAll(
        ActionHttp.layer(
          ActionHttp.make([Identify], { authentication: Session }),
          identify
        ),
        HttpRouter.add(
          "GET",
          "/own",
          Effect.map(Identity, ({ id }) => HttpServerResponse.text(id))
        ).pipe(Layer.provide(Authentication.protect(Session).layer))
      ).pipe(
        Layer.provide(
          Authentication.layer(Session, (session) =>
            Redacted.value(session) === "s1"
              ? Effect.succeed({ id: "alice" })
              : Effect.fail(new Action.Unauthenticated())
          )
        )
      )
    );

    const signedIn = get("/own");
    signedIn.headers.set("cookie", "session=s1");

    const response = await web.handler(signedIn);

    await expect(response.text()).resolves.toBe("alice");

    const anonymous = await web.handler(get("/own"));
    const action = await web.handler(post("/api/identify"));
    await expect(textAnswerOf(anonymous)).resolves.toStrictEqual(
      await textAnswerOf(action)
    );
  });
});

const jsonAnswerOf = async (response: Response) => [
  response.status,
  response.headers.get("www-authenticate"),
  response.headers.get("cache-control"),
  await response.json(),
];

describe("an error a descriptor declares", () => {
  const Open = Action.make("open", {
    description: "Open to anyone",
    readOnly: true,
    caller: Action.Anyone,
    success: Schema.String,
  });

  const Http = ActionHttp.make([Identify, Open], { authentication: Checked });

  const apps = [
    Action.implement(Identify, () => Effect.map(Identity, ({ id }) => id), {
      authorize: Action.allowAll,
    }),
    Action.implement(Open, () => Effect.succeed("open")),
  ];

  const unavailable = new Unavailable({
    operation: " verify ",
    retryAfter: 30,
  });

  const unavailableForDown = (token: Redacted.Redacted) =>
    Redacted.value(token) === "down"
      ? Effect.fail(unavailable)
      : Effect.succeed({ id: Redacted.value(token) });

  const provider = Authentication.layer(Checked, unavailableForDown);

  const routes = Layer.mergeAll(
    ActionHttp.layer(Http, apps),
    ActionMcp.layerHttp(apps, {
      name: "test",
      version: "0",
      authentication: Checked,
    }),
    HttpRouter.add(
      "GET",
      "/own",
      Effect.map(Identity, ({ id }) => HttpServerResponse.text(id))
    ).pipe(Layer.provide(Authentication.protect(Checked).layer))
  ).pipe(Layer.provide(provider));

  it.effect(
    "is declared on every protected endpoint, and decoded by its clients, as their type says",
    () =>
      Effect.gen(function* () {
        const client = yield* ActionHttp.client(Http, as("down"));

        expect(yield* Effect.flip(client.identify())).toStrictEqual(
          unavailable
        );
        expect(yield* client.open()).toBe("open");

        expectTypeOf<Unavailable>().toExtend<
          Effect.Error<ReturnType<typeof client.identify>>
        >();
        expectTypeOf<Expired>().toExtend<
          Effect.Error<ReturnType<typeof client.identify>>
        >();
        expectTypeOf<Unavailable>().not.toExtend<
          Effect.Error<ReturnType<typeof client.open>>
        >();

        const document = OpenApi.fromApi(Http.api);
        expect(
          Object.keys(document.paths["/api/identify"]?.post?.responses ?? {})
        ).toStrictEqual(expect.arrayContaining(["401", "503"]));
        expect(
          Object.keys(document.paths["/api/open"]?.post?.responses ?? {})
        ).not.toContain("503");
      }).pipe(Effect.provide(Testing.layer(routes)))
  );

  it("is sent as its status and the JSON its schema encodes, its text as it is, no-store and unchallenged, on the action route, the MCP endpoint, a protect route and refusalResponse alike", async () => {
    const web = serve(routes);

    const action = await jsonAnswerOf(
      await web.handler(withBearer(request(), "down"))
    );

    const mcp = await jsonAnswerOf(
      await web.handler(
        mcpRequest({
          method: "tools/call",
          params: { name: "identify", arguments: {} },
          headers: { authorization: "Bearer down" },
        })
      )
    );

    const own = await jsonAnswerOf(
      await web.handler(
        new Request("http://localhost/own", {
          headers: { authorization: "Bearer down" },
        })
      )
    );

    const outside = await jsonAnswerOf(
      HttpServerResponse.toWeb(
        Authentication.refusalResponse(unavailable, {
          authentication: Checked,
          authorization: "Bearer down",
        })
      )
    );

    expect(action).toStrictEqual([
      503,
      null,
      "no-store",
      Schema.encodeSync(Schema.toCodecJson(Unavailable))(unavailable),
    ]);
    expect([mcp, own, outside]).toStrictEqual([action, action, action]);

    const publicToolPresentingCredential = await jsonAnswerOf(
      await web.handler(
        mcpRequest({
          method: "tools/call",
          params: { name: "open", arguments: {} },
          headers: { authorization: "Bearer down" },
        })
      )
    );

    expect(publicToolPresentingCredential).toStrictEqual(action);
  });

  it("is refused where it encodes with a built-in error's _tag, and accepts the built-in", () => {
    class Forbidden extends Schema.TaggedError<
      Forbidden,
      { readonly brand: unique symbol }
    >()("Forbidden", {}) {}

    expect(() =>
      Authentication.make("test.Builtin", Identity, { error: Forbidden })
    ).toThrow(
      'Authentication "test.Builtin": error _tag "Forbidden" names two error schemas'
    );
    expect(
      Authentication.make("test.Builtin", Identity, { error: Action.Forbidden })
        .error
    ).toStrictEqual([Action.Forbidden]);
  });

  it("is refused where two of its error schemas share a _tag", () => {
    expect(() =>
      Authentication.make("test.Shared", Identity, {
        error: [
          Schema.TaggedStruct("Down", {}),
          Schema.TaggedStruct("Down", { retry: Schema.Finite }),
        ],
      })
    ).toThrow(
      'Authentication "test.Shared": error _tag "Down" names two error schemas'
    );
  });

  it("is the only failure besides a refusal refusalResponse renders", () => {
    expect(() =>
      // @ts-expect-error -- Without the descriptor declaring it, it is no answer authentication gives.
      Authentication.refusalResponse(unavailable)
    ).toThrow(
      "Not a refusal, nor an error the authentication declares: pass the descriptor declaring it as `authentication`, or answer the error yourself"
    );
  });
});

const withSession = (sending: Request, session: string) => {
  sending.headers.set("cookie", `session=${session}`);

  return sending;
};

const declaredWithCookieNamedAtStartup = (cookie: string) =>
  Authentication.make("test.DeploymentSession", Identity, {
    security: HttpApiSecurity.apiKey({ in: "cookie", key: cookie }),
  });

describe("a scheme other than Bearer", () => {
  const Session = Authentication.make("test.Session", Identity, {
    security: HttpApiSecurity.apiKey({ in: "cookie", key: "session" }),
  });

  const verified: string[] = [];

  const sessions = Authentication.layer(Session, (session) => {
    verified.push(Redacted.value(session));

    if (Redacted.value(session) === "s1") {
      return Effect.succeed({ id: "alice" });
    }

    if (Redacted.value(session) === "narrow") {
      return Effect.fail(new Action.Forbidden({ scopes: ["write"] }));
    }

    return Effect.fail(new Action.Unauthenticated());
  });

  const deployment = () =>
    serve(
      Layer.mergeAll(
        ActionHttp.layer(
          ActionHttp.make([Identify], { authentication: Session }),
          identify
        ),
        ActionMcp.layerHttp(identify, {
          name: "test",
          version: "0",
          authentication: Session,
        })
      ).pipe(Layer.provide(sessions))
    );

  it("verifies the credential its scheme decodes, never an absent one, over HTTP and MCP, and challenges no 401 with Bearer", async () => {
    const web = deployment();
    const ok = await web.handler(withSession(post("/api/identify"), "s1"));
    expect([ok.status, await ok.json()]).toStrictEqual([200, "alice"]);

    const tool = await web.handler(withSession(rawToolCall("identify"), "s1"));
    await expect(tool.json()).resolves.toMatchObject({
      result: { structuredContent: "alice" },
    });

    for (const refused of [
      await web.handler(post("/api/identify")),
      await web.handler(withSession(post("/api/identify"), "stale")),
      await web.handler(rawToolCall("identify")),
    ]) {
      expect([
        refused.status,
        refused.headers.get("www-authenticate"),
      ]).toStrictEqual([401, null]);
      expect(refused.headers.get("cache-control")).toBe("no-store");
    }

    expect(verified).toStrictEqual(["s1", "s1", "stale"]);
  });

  it("challenges no refusal with Bearer, and steps no tool's call up", async () => {
    const web = deployment();

    const narrow = await web.handler(
      withSession(post("/api/identify"), "narrow")
    );

    expect([
      narrow.status,
      narrow.headers.get("www-authenticate"),
    ]).toStrictEqual([403, null]);

    const Locked = Action.make("locked", {
      description: "",
      readOnly: false,
      caller: Identity,
    });

    const locked = serve(
      ActionMcp.layerHttp(
        Action.implement(Locked, () => Effect.void, {
          authorize: () =>
            Effect.fail(new Action.Forbidden({ scopes: ["write"] })),
        }),
        { name: "test", version: "0", authentication: Session }
      ).pipe(Layer.provide(sessions))
    );

    const refused = await locked.handler(
      withSession(rawToolCall("locked"), "s1")
    );

    expect([
      refused.status,
      refused.headers.get("www-authenticate"),
    ]).toStrictEqual([200, null]);
    await expect(refused.json()).resolves.toMatchObject({
      result: { isError: true },
    });
  });

  it("serves a cookie the deployment names at startup, to a client whose declaration names another", async () => {
    const served = declaredWithCookieNamedAtStartup("__Secure-session");

    const web = serve(
      ActionHttp.layer(
        ActionHttp.make([Identify], { authentication: served }),
        identify
      ).pipe(
        Layer.provide(
          Authentication.layer(served, (session) =>
            Redacted.value(session) === "s1"
              ? Effect.succeed({ id: "alice" })
              : Effect.fail(new Action.Unauthenticated())
          )
        )
      )
    );

    const sent = async (cookie: string) => {
      const sending = post("/api/identify");
      sending.headers.set("cookie", cookie);

      return await web.handler(sending);
    };

    const deploymentCookie = await sent("__Secure-session=s1");

    expect(deploymentCookie.status).toBe(200);

    const declaredCookie = await sent("session=s1");

    expect(declaredCookie.status).toBe(401);

    const browserClientOfAnotherCookieName = ActionHttp.fetchClient(
      ActionHttp.make([Identify], {
        authentication: declaredWithCookieNamedAtStartup("session"),
      }),
      {
        baseUrl: "http://localhost",
        fetch: async (input, init) => {
          const sending = new Request(input, init);
          sending.headers.set("cookie", "__Secure-session=s1");

          return await web.handler(sending);
        },
      }
    );

    await expect(
      Effect.runPromise(browserClientOfAnotherCookieName.identify())
    ).resolves.toBe("alice");
  });

  it.each([
    [
      { security: HttpApiSecurity.apiKey({ in: "cookie", key: "session" }) },
      {
        security: HttpApiSecurity.apiKey({
          in: "cookie",
          key: "__Secure-session",
        }),
      },
    ],
    [
      { security: HttpApiSecurity.bearer },
      { security: HttpApiSecurity.http({ scheme: "Token" }) },
    ],
    [{}, {}],
  ])(
    "refuses, when its layer builds, a binding whose descriptor is not its provider's: %#",
    async (binding, provider) => {
      const web = serve(
        ActionHttp.layer(
          ActionHttp.make([Identify], {
            authentication: Authentication.make(
              "test.MismatchedSession",
              Identity,
              binding
            ),
          }),
          identify
        ).pipe(
          Layer.provide(
            Authentication.layer(
              Authentication.make("test.MismatchedSession", Identity, provider),
              () => Effect.succeed({ id: "alice" })
            )
          )
        )
      );

      await expect(web.handler(post("/api/identify"))).rejects.toThrow(
        `Authentication "test.MismatchedSession": the descriptor named here is not the one its provider was built from (build both from one descriptor)`
      );
    }
  );

  it.each([
    [
      "an MCP endpoint",
      ActionMcp.layerHttp(identify, {
        name: "test",
        version: "0",
        authentication: MismatchedCookie,
      }),
      () => rawToolCall("identify"),
    ],
    [
      "a route of the host's own",
      HttpRouter.add(
        "GET",
        "/own",
        Effect.map(Identity, ({ id }) => HttpServerResponse.text(id))
      ).pipe(Layer.provide(Authentication.protect(MismatchedCookie).layer)),
      () => new Request("http://localhost/own"),
    ],
  ] as const)(
    "refuses, when its layer builds, %s whose descriptor is not its provider's",
    async (_surface, served, makeRequest) => {
      const web = serve(
        served.pipe(
          Layer.provide(
            Authentication.layer(
              Authentication.make("test.MismatchedCookie", Identity, {
                security: HttpApiSecurity.apiKey({
                  in: "cookie",
                  key: "session",
                }),
              }),
              () => Effect.succeed({ id: "alice" })
            )
          )
        )
      );

      await expect(web.handler(makeRequest())).rejects.toThrow(
        `Authentication "test.MismatchedCookie": the descriptor named here is not the one its provider was built from (build both from one descriptor)`
      );
    }
  );

  it("refuses a protected resource, which only a Bearer scheme publishes", () => {
    expect(() =>
      Authentication.layer(Session, () => Effect.succeed({ id: "alice" }), {
        // @ts-expect-error -- A cookie names no OAuth resource.
        protectedResource: {
          resource: "https://a.example",
          authorizationServers: ["https://as"],
        },
      })
    ).toThrow(
      "A protected resource is published only for a Bearer scheme: drop `protectedResource`, or authenticate with a Bearer descriptor"
    );
  });
});

describe("Basic", () => {
  const Basic = Authentication.make("test.Basic", Identity, {
    security: HttpApiSecurity.basic,
  });

  const basic = Authentication.layer(Basic, ({ username, password }) =>
    username === "" && Redacted.value(password) === "token"
      ? Effect.succeed({ id: "service" })
      : Effect.fail(new Action.Unauthenticated())
  );

  it("verifies a token sent as the password, and challenges with its realm", async () => {
    const web = serve(
      ActionHttp.layer(
        ActionHttp.make([Identify], { authentication: Basic }),
        identify
      ).pipe(Layer.provide(basic))
    );

    const token = await web.handler(request(`Basic ${btoa(":token")}`));
    expect([token.status, await token.json()]).toStrictEqual([200, "service"]);

    const anonymous = await web.handler(request());
    expect([
      anonymous.status,
      anonymous.headers.get("www-authenticate"),
    ]).toStrictEqual([401, 'Basic realm="test.Basic"']);
  });

  it.effect(
    "answers a handler's Unauthenticated with its 401 and the realm's challenge",
    () => {
      const refusing = Action.implement(
        Identify,
        () => new Action.Unauthenticated(),
        {
          authorize: Action.allowAll,
        }
      );

      const routes = ActionHttp.layer(
        ActionHttp.make([Identify], { authentication: Basic }),
        refusing
      ).pipe(Layer.provide(basic));

      return Effect.gen(function* () {
        const response = yield* send(request(`Basic ${btoa(":token")}`));

        expect([
          response.status,
          response.headers["www-authenticate"],
        ]).toStrictEqual([401, 'Basic realm="test.Basic"']);
      }).pipe(Effect.provide(Testing.layer(routes)));
    }
  );

  it("answers a host route's refusal as its routes do, through refusal", async () => {
    const web = serve(
      ActionHttp.layer(
        ActionHttp.make([Identify], { authentication: Basic }),
        identify
      ).pipe(Layer.provide(basic))
    );

    const route = await web.handler(request());

    for (const error of [
      new Action.Unauthenticated(),
      new Action.Forbidden({ scopes: ["a"] }),
    ]) {
      const own = Authentication.refusalResponse(error, {
        authentication: Basic,
      });

      expect(own.headers["www-authenticate"]).toBe(
        Predicate.isTagged(error, "Unauthenticated")
          ? route.headers.get("www-authenticate")
          : undefined
      );
      expect(own.headers["cache-control"]).toBe("no-store");
    }
  });
});

const answersPresentingSecrets = async (
  web: ReturnType<typeof serve>,
  present: (sending: Request, secret: string) => void
) => {
  const withSecret = (sending: Request, secret: string) => {
    present(sending, secret);

    return sending;
  };

  const bare = await valueOf(await web.handler(rawToolCall("ping")));

  const empty = await valueOf(
    await web.handler(withSecret(rawToolCall("ping"), ""))
  );

  const stale = await web.handler(withSecret(rawToolCall("ping"), "stale"));

  const valid = await valueOf(
    await web.handler(withSecret(rawToolCall("identify"), "s1"))
  );

  return [bare, empty, stale.status, valid];
};

const aliceForS1Recording = (seen: string[]) => (secret: string) => {
  seen.push(secret);

  return secret === "s1"
    ? Effect.succeed({ id: "alice" })
    : Effect.fail(new Action.Unauthenticated());
};

describe("a public action beside protected ones", () => {
  const Ping = Action.make("ping", {
    description: "Answer anyone",
    readOnly: true,
    caller: Action.Anyone,
    success: Schema.String,
  });

  const mixed = Action.implement(
    [Ping, Identify],
    {
      ping: () => Effect.succeed("pong"),
      identify: () => Effect.map(Identity, ({ id }) => id),
    },
    { authorize: Action.allowAll }
  );

  it("ignores any credential over HTTP, never verifying it", async () => {
    const seen: unknown[] = [];

    const web = serve(
      ActionHttp.layer(
        ActionHttp.make([Ping, Identify], { authentication: Login }),
        mixed
      ).pipe(
        Layer.provide(
          Authentication.layer(Login, (token) => {
            seen.push(Redacted.value(token));

            return Effect.fail(new Action.Unauthenticated());
          })
        )
      )
    );

    for (const authorization of [
      undefined,
      "Bearer forged",
      "Bearer",
      "Basic garbage",
    ]) {
      const sent = post("/api/ping");

      if (authorization !== undefined) {
        sent.headers.set("authorization", authorization);
      }

      const response = await web.handler(sent);
      expect([response.status, await response.json()]).toStrictEqual([
        200,
        "pong",
      ]);
    }

    expect(seen).toStrictEqual([]);
  });

  it("verifies a public MCP call's cookie only when it presents one", async () => {
    const Cookie = Authentication.make("test.Cookie", Identity, {
      security: HttpApiSecurity.apiKey({ in: "cookie", key: "session" }),
    });

    const seen: string[] = [];
    const verifyRecording = aliceForS1Recording(seen);

    const web = serve(
      ActionMcp.layerHttp(mixed, {
        name: "test",
        version: "0",
        authentication: Cookie,
      }).pipe(
        Layer.provide(
          Authentication.layer(Cookie, (session) =>
            verifyRecording(Redacted.value(session))
          )
        )
      )
    );

    await expect(
      answersPresentingSecrets(web, (sending, secret) => {
        sending.headers.set("cookie", `session=${secret}`);
      })
    ).resolves.toStrictEqual(["pong", "pong", 401, "alice"]);
    expect(seen).toStrictEqual(["stale", "s1"]);
  });

  it("verifies a public MCP call's Basic credentials only when it presents some", async () => {
    const Basic = Authentication.make("test.Basic", Identity, {
      security: HttpApiSecurity.basic,
    });

    const seen: string[] = [];
    const verifyRecording = aliceForS1Recording(seen);

    const web = serve(
      ActionMcp.layerHttp(mixed, {
        name: "test",
        version: "0",
        authentication: Basic,
      }).pipe(
        Layer.provide(
          Authentication.layer(Basic, ({ password }) =>
            verifyRecording(Redacted.value(password))
          )
        )
      )
    );

    await expect(
      answersPresentingSecrets(web, (sending, secret) => {
        sending.headers.set(
          "authorization",
          secret === "" ? "Basic " : `Basic ${btoa(`:${secret}`)}`
        );
      })
    ).resolves.toStrictEqual(["pong", "pong", 401, "alice"]);
    expect(seen).toStrictEqual(["stale", "s1"]);
  });
});

describe("an empty credential", () => {
  it("never reaches the verifier, which would accept anything", async () => {
    const seen: string[] = [];

    const web = serve(
      ActionHttp.layer(IdentifyHttp, identify).pipe(
        Layer.provide(
          Authentication.layer(Login, (token) =>
            Effect.sync(() => {
              seen.push(Redacted.value(token));

              return { id: "anyone" };
            })
          )
        )
      )
    );

    for (const header of ["Bearer", "Bearer ", "Basic x"]) {
      const refused = await web.handler(request(header));

      expect([header, refused.status]).toStrictEqual([header, 401]);
    }

    expect(seen).toStrictEqual([]);
  });
});

const callAction = (path: string, body: Schema.Json, token?: string) => {
  const sent = post(`/api/${path}`, body);

  return token === undefined ? sent : withBearer(sent, token);
};

const blobBodyRequest = (body: string, type?: string) =>
  new Request("http://localhost/api/secret", {
    method: "POST",
    headers: type === undefined ? {} : { "content-type": type },
    body: new Blob([body]),
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
    { authorize: Action.allowAll }
  );

  it.effect("builds its verifier once, on every surface it covers", () =>
    Effect.gen(function* () {
      let built = 0;

      const prefixed = Authentication.layer(
        Login,
        Effect.gen(function* () {
          built += 1;

          const { prefix } = yield* Tokens;

          return (token: Redacted.Redacted) =>
            Effect.succeed({ id: `${prefix}${Redacted.value(token)}` });
        })
      );

      expectTypeOf<Layer.Services<typeof prefixed>>().toEqualTypeOf<Tokens>();

      const routes = Layer.mergeAll(
        ActionHttp.layer(Http, guarded),
        ActionMcp.layerHttp(guarded, {
          name: "test",
          version: "0",
          authentication: Login,
        })
      ).pipe(
        Layer.provide(
          prefixed.pipe(
            Layer.provide(Layer.succeed(Tokens, { prefix: "actor:" }))
          )
        )
      );

      yield* Effect.gen(function* () {
        const response = yield* send(
          callAction("secret", { note: "hi" }, "alice")
        );

        expect(yield* response.json).toBe("actor:alice: hi");

        const mcp = yield* ActionMcp.client([Secret], as("alice"));

        expect(yield* mcp.secret({ note: "hi" })).toBe("actor:alice: hi");
      }).pipe(Effect.provide(Testing.layer(routes)));

      expect(built).toBe(1);
    })
  );

  it("authenticates only the protected actions of a layer, so one layer serves public and private ones", async () => {
    const web = serve(
      ActionHttp.layer(Http, [open, guarded]).pipe(Layer.provide(authenticate))
    );

    const anyone = await web.handler(callAction("public", {}));
    expect(anyone.status).toBe(200);
    expect(anyone.headers.has("cache-control")).toBe(false);

    const refused = await web.handler(callAction("secret", { note: "hi" }));
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toBe("Bearer");

    const response = await web.handler(
      callAction("secret", { note: "hi" }, "alice")
    );

    await expect(response.json()).resolves.toBe("alice: hi");
  });

  it("marks an MCP endpoint's answer no-store only where it authenticates the request", async () => {
    const web = serve(
      ActionMcp.layerHttp([open, guarded], {
        name: "test",
        version: "0",
        authentication: Login,
      }).pipe(Layer.provide(authenticate))
    );

    for (const sent of [
      mcpRequest({ method: "tools/list" }),
      rawToolCall("public"),
    ]) {
      const readingNoCredential = await web.handler(sent);
      expect(readingNoCredential.status).toBe(200);
      expect(readingNoCredential.headers.has("cache-control")).toBe(false);
    }

    const signedIn = await web.handler(
      withBearer(rawToolCall("secret", { note: "hi" }), "alice")
    );

    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get("cache-control")).toBe("no-store");
  });

  it("runs before decoding, so an unauthenticated caller learns nothing of the input", async () => {
    let calls = 0;

    const counted = Action.implement(
      Secret,
      ({ note }) =>
        Effect.sync(() => {
          calls += 1;

          return note;
        }),
      {
        authorize: Action.allowAll,
      }
    );

    const web = serve(
      ActionHttp.layer(Http, counted).pipe(Layer.provide(authenticate))
    );

    for (const sent of [
      blobBodyRequest("{", "application/json"),
      callAction("secret", { note: 42 }),
      blobBodyRequest('{"note":"hi"}'),
      blobBodyRequest('{"note":"hi"}', "text/plain"),
    ]) {
      const response = await web.handler(sent);

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
    }

    const malformedJson = await web.handler(
      withBearer(blobBodyRequest("{", "application/json"), "alice")
    );

    expect(malformedJson.status).toBe(400);

    const wrongField = await web.handler(
      callAction("secret", { note: 42 }, "alice")
    );

    expect(wrongField.status).toBe(400);

    for (const [type, refused] of [
      [undefined, "none"],
      ["text/plain", "text/plain"],
    ] as const) {
      const response = await web.handler(
        withBearer(blobBodyRequest('{"note":"hi"}', type), "alice")
      );

      expect(response.status).toBe(415);
      await expect(response.text()).resolves.toContain(refused);
    }

    expect(calls).toBe(0);
  });

  it("is what the binding documents: each protected operation's security, from its contract", () => {
    const example = OpenApi.fromApi(ExampleHttp.api);
    expect(example.paths["/api/status"]?.post?.security).toStrictEqual([]);
    expect(example.paths["/api/renameUser"]?.post?.security).toStrictEqual([
      { "example.Login": [] },
    ]);
    expect(example.paths["/api/double"]?.post?.security).toStrictEqual([
      { "example.Login": [] },
    ]);
    expect(example.components.securitySchemes).toMatchObject({
      "example.Login": { type: "http", scheme: "Bearer" },
    });
  });

  it.effect(
    "authenticates every request to an endpoint of protected tools alone",
    () =>
      Effect.gen(function* () {
        const anonymous = yield* ActionMcp.client([Secret]);
        expect(
          yield* Effect.flip(anonymous.secret({ note: "hi" }))
        ).toBeInstanceOf(Action.Unauthenticated);

        const malformed = yield* send(
          new Request("http://localhost/mcp", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{",
          })
        );

        expect(malformed.status).toBe(401);

        const alice = yield* ActionMcp.client([Secret], as("alice"));

        expect(yield* alice.secret({ note: "hi" })).toBe("alice: hi");
      }).pipe(
        Effect.provide(
          Testing.layer(
            ActionMcp.layerHttp(guarded, {
              name: "test",
              version: "0",
              authentication: Login,
            }).pipe(Layer.provide(authenticate))
          )
        )
      )
  );

  it.effect("leaves identity to the host on a local surface", () =>
    Effect.gen(function* () {
      const { toolkit, layer } = ActionToolkit.make(guarded);

      const results = yield* Effect.gen(function* () {
        const tools = yield* toolkit;

        return yield* Stream.runCollect(
          yield* tools.handle("secret", { note: "hi" })
        );
      }).pipe(
        Effect.provideService(Identity, { id: "host" }),
        Effect.provide(layer)
      );

      expect(results).toMatchObject([{ isFailure: false, result: "host: hi" }]);
    })
  );
});

const whoAmIRequest = (headers: Record<string, string>) =>
  new Request("https://api.example.com/api/whoAmI", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });

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
    })
  );

describe("Authentication.layer beside other middleware", () => {
  class Tenant extends Context.Service<Tenant, string>()("test/Tenant") {}

  class Verifier extends Context.Service<
    Verifier,
    {
      readonly verify: (
        tenant: string,
        token: string
      ) => Effect.Effect<{ readonly id: string }, Action.Unauthenticated>;
    }
  >()("test/Verifier") {}

  const resource = {
    resource: "https://api.example.com/mcp",
    authorizationServers: ["https://auth.example.com"],
  } as const;

  const metadata =
    "https://api.example.com/.well-known/oauth-protected-resource/mcp";

  const verifierLayerCountingBuilds = () => {
    const builds = { count: 0 };

    const layer = Layer.effect(
      Verifier,
      Effect.sync(() => {
        builds.count += 1;

        return {
          verify: (tenant: string, token: string) =>
            token === "bad"
              ? Effect.fail(
                  new Action.Unauthenticated({ message: "Invalid token." })
                )
              : Effect.succeed({ id: `${token}@${tenant}` }),
        };
      })
    );

    return { builds, layer };
  };

  const resolveTenant = HttpRouter.middleware<{ provides: Tenant }>()((route) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (incoming) =>
      Effect.provideService(
        route,
        Tenant,
        incoming.headers["x-tenant"] ?? "none"
      )
    )
  );

  const buildVerifier = Effect.gen(function* () {
    const { verify: check } = yield* Verifier;

    return (token: Redacted.Redacted) =>
      Effect.flatMap(Tenant, (tenant) => check(tenant, Redacted.value(token)));
  });

  const authentication = Authentication.layer(Login, buildVerifier, {
    protectedResource: resource,
  });

  const WhoAmI = Action.make("whoAmI", {
    description: "Name the authenticated caller",
    readOnly: true,
    caller: Identity,
    success: Schema.String,
  });

  const Http = ActionHttp.make([WhoAmI], { authentication: Login });

  const whoAmI = Action.implement(
    WhoAmI,
    () => Effect.map(Identity, ({ id }) => id),
    {
      authorize: () =>
        Effect.flatMap(Identity, ({ id }) =>
          id.endsWith("@locked")
            ? Effect.fail(new Action.Forbidden({ scopes: ["admin"] }))
            : Effect.void
        ),
    }
  );

  class AccessLog extends HttpApiMiddleware.Service<
    AccessLog,
    { requires: Identity }
  >()("test/AccessLog") {}

  const accessLog = Layer.succeed(AccessLog, (route) =>
    Effect.flatMap(Identity, ({ id }) =>
      Effect.map(route, HttpServerResponse.setHeader("x-caller", id))
    )
  );

  const mcpCall = (headers: Record<string, string>) =>
    Effect.flatMap(
      ActionMcp.client([WhoAmI], {
        transformClient: HttpClient.mapRequest(
          HttpClientRequest.setHeaders(headers)
        ),
      }),
      (mcp) => mcp.whoAmI()
    );

  const stepUp = `Bearer error="insufficient_scope", scope="admin", resource_metadata="${metadata}", error_description="Not allowed."`;

  it.effect(
    "reads a request service from router middleware provided after it, over HTTP and MCP, refusing and stepping up as without it",
    () =>
      Effect.gen(function* () {
        const acme = yield* send(
          whoAmIRequest({ authorization: "Bearer alice", "x-tenant": "acme" })
        );

        const globex = yield* send(
          whoAmIRequest({ authorization: "Bearer bob", "x-tenant": "globex" })
        );

        expect([yield* acme.json, yield* globex.json]).toStrictEqual([
          "alice@acme",
          "bob@globex",
        ]);

        expect(
          yield* mcpCall({
            authorization: "Bearer carol",
            "x-tenant": "initech",
          })
        ).toBe("carol@initech");

        const anonymous = yield* send(whoAmIRequest({ "x-tenant": "acme" }));
        expect([
          anonymous.status,
          anonymous.headers["www-authenticate"],
        ]).toStrictEqual([401, `Bearer resource_metadata="${metadata}"`]);
        expect(anonymous.headers["cache-control"]).toBe("no-store");

        const invalid = yield* send(
          whoAmIRequest({ authorization: "Bearer bad", "x-tenant": "acme" })
        );

        expect([
          invalid.status,
          invalid.headers["www-authenticate"],
        ]).toStrictEqual([
          401,
          `Bearer error="invalid_token", resource_metadata="${metadata}"`,
        ]);

        const locked = yield* send(
          whoAmIRequest({ authorization: "Bearer alice", "x-tenant": "locked" })
        );

        expect([
          locked.status,
          locked.headers["www-authenticate"],
        ]).toStrictEqual([403, stepUp]);

        const tool = mcpRequest({
          method: "tools/call",
          params: { name: "whoAmI", arguments: {} },
        });

        tool.headers.set("authorization", "Bearer alice");
        tool.headers.set("x-tenant", "locked");
        const lockedTool = yield* send(tool);
        expect([
          lockedTool.status,
          lockedTool.headers["www-authenticate"],
        ]).toStrictEqual([403, stepUp]);
      }).pipe(
        Effect.provide(
          Testing.layer(
            Layer.mergeAll(
              ActionHttp.layer(Http, whoAmI),
              ActionMcp.layerHttp(whoAmI, {
                name: "test",
                version: "0",
                authentication: Login,
              })
            ).pipe(
              Layer.provide(authentication),
              Layer.provide(verifierLayerCountingBuilds().layer),
              Layer.provide(resolveTenant.layer)
            )
          )
        )
      )
  );

  it.effect(
    "builds once however many layers it is provided to, whatever middleware they run",
    () =>
      Effect.gen(function* () {
        const { builds, layer } = verifierLayerCountingBuilds();
        const runs = { count: 0 };

        const countingBuilderRuns = Authentication.layer(
          Login,
          Effect.andThen(
            Effect.sync(() => {
              runs.count += 1;
            }),
            buildVerifier
          ),
          { protectedResource: resource }
        );

        const routes = Layer.mergeAll(
          ActionHttp.layer(Http, whoAmI, { middleware: [AccessLog] }),
          ActionMcp.layerHttp(whoAmI, {
            name: "test",
            version: "0",
            authentication: Login,
          }),
          ActionMcp.layerHttp(whoAmI, {
            name: "test",
            version: "0",
            path: "/other",
            authentication: Login,
          })
        ).pipe(
          Layer.provide([countingBuilderRuns, accessLog]),
          Layer.provide(layer),
          Layer.provide(resolveTenant.layer)
        );

        yield* Effect.gen(function* () {
          for (const tenant of ["globex", "acme"]) {
            const alice = yield* send(
              whoAmIRequest({
                authorization: "Bearer alice",
                "x-tenant": tenant,
              })
            );

            expect([
              alice.status,
              alice.headers["x-caller"],
              yield* alice.json,
            ]).toStrictEqual([200, `alice@${tenant}`, `alice@${tenant}`]);
          }

          expect(
            yield* mcpCall({ authorization: "Bearer bob", "x-tenant": "acme" })
          ).toBe("bob@acme");
        }).pipe(Effect.provide(Testing.layer(routes)));

        expect([runs.count, builds.count]).toStrictEqual([1, 1]);
      })
  );

  it.effect(
    "answers a tenant's member, refuses another tenant's and a non-member with 403, and challenges a signed-out caller",
    () =>
      Effect.gen(function* () {
        const alice = yield* whoAmIAt("acme.example.com", "alice");
        expect([
          alice.status,
          alice.headers["x-actor"],
          yield* alice.json,
        ]).toStrictEqual([200, "alice", { id: "alice", tenantId: "acme" }]);

        for (const [host, token] of [
          ["acme.example.com", "bob"],
          ["globex.example.com", "alice"],
        ] as const) {
          const outsider = yield* whoAmIAt(host, token);
          expect([outsider.status, outsider.headers["x-actor"]]).toStrictEqual([
            403,
            undefined,
          ]);
          expect(yield* outsider.json).toMatchObject({
            message: "Not a member of this tenant.",
          });
        }

        const anonymous = yield* whoAmIAt("acme.example.com");
        expect([
          anonymous.status,
          anonymous.headers["www-authenticate"],
          anonymous.headers["x-actor"],
        ]).toStrictEqual([401, "Bearer", undefined]);

        const bob = yield* whoAmIAt("other.example.com", "bob");
        expect([
          bob.status,
          bob.headers["x-actor"],
          yield* bob.json,
        ]).toStrictEqual([200, "bob", { id: "bob", tenantId: "other" }]);
      }).pipe(
        Effect.provide(
          Testing.layer(tenantRoutes.pipe(Layer.provide(Users.layerMemory)))
        )
      )
  );

  it("refuses a foreign Host or Origin under a global policy before a tenant-reading verifier's authentication", async () => {
    const web = serve(
      Layer.mergeAll(requestPolicy, tenantRoutes).pipe(
        Layer.provide(Users.layerMemory)
      )
    );

    const statusChallengeAndText = async (
      url: string,
      headers: Record<string, string> = {}
    ) => {
      const response = await web.handler(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: "{}",
        })
      );

      return [
        response.status,
        response.headers.get("www-authenticate"),
        await response.text(),
      ];
    };

    await expect(
      statusChallengeAndText("http://evil.example/api/whoAmI")
    ).resolves.toStrictEqual([403, null, "Host not allowed"]);
    await expect(
      statusChallengeAndText("http://evil.example/api/whoAmI", {
        authorization: "Bearer forged",
      })
    ).resolves.toStrictEqual([403, null, "Host not allowed"]);
    await expect(
      statusChallengeAndText("http://localhost/api/whoAmI", {
        origin: "https://evil.example",
      })
    ).resolves.toStrictEqual([403, null, "Origin not allowed"]);

    const result = await statusChallengeAndText("http://localhost/api/whoAmI");

    expect(result.slice(0, 2)).toStrictEqual([401, "Bearer"]);
  });

  const tenantSeenByHostCheck: string[] = [];

  const hostCheck = HttpRouter.middleware()((route) =>
    Effect.gen(function* () {
      const sent = yield* HttpServerRequest.HttpServerRequest;

      const url = HttpServerRequest.toURL(
        sent.modify({ url: sent.originalUrl })
      );

      if (Option.isSome(url) && url.value.hostname === "api.example.com") {
        return yield* route;
      }

      tenantSeenByHostCheck.push(
        Option.getOrElse(yield* Effect.serviceOption(Tenant), () => "no tenant")
      );

      return HttpServerResponse.text("Host not allowed", { status: 403 });
    })
  );

  it.each([
    [
      "alone",
      () =>
        serve(
          ActionHttp.layer(Http, whoAmI).pipe(
            Layer.provide(authenticate),
            Layer.provide(hostCheck.layer)
          )
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
            Layer.provide(verifierLayerCountingBuilds().layer),
            Layer.provide(resolveTenant.layer)
          )
        ),
      ["acme"],
    ],
    [
      "around the layer's middleware reading the identity",
      () =>
        serve(
          ActionHttp.layer(Http, whoAmI, { middleware: [AccessLog] }).pipe(
            Layer.provide([authenticate, accessLog]),
            Layer.provide(hostCheck.layer)
          )
        ),
      ["no tenant"],
    ],
  ])(
    "runs a Host check provided around routes before their authentication: %s",
    async (_, web, refused) => {
      tenantSeenByHostCheck.length = 0;

      const response = await web().handler(
        new Request("https://evil.example/api/whoAmI", {
          method: "POST",
          headers: { "content-type": "application/json", "x-tenant": "acme" },
          body: "{}",
        })
      );

      expect([
        response.status,
        response.headers.get("x-caller"),
        tenantSeenByHostCheck,
      ]).toStrictEqual([403, null, refused]);
    }
  );
});

describe("one MCP URL for signed-out and signed-in callers", () => {
  const issuer = "https://auth.example.com";

  const mcpBehindInMemoryOAuthServer = (resource: string) => {
    const web = serve(
      exampleMcp.pipe(
        Layer.provide(
          Authentication.layer(ExampleLogin, exampleVerify, {
            protectedResource: { ...exampleProtectedResource, resource },
          })
        ),
        Layer.provide(Users.layerMemory)
      )
    );

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
        access_token: scope.split(" ").includes("users:write")
          ? "alice"
          : "reader",
        token_type: "Bearer",
        expires_in: 3600,
        scope,
      });
    };

    const fetch = async (sent: Request): Promise<Response> => {
      if (sent.url.startsWith(issuer)) {
        return await authorizationServer(sent);
      }

      const response = await web.handler(sent);

      const called =
        sent.headers.get("mcp-name") ?? sent.headers.get("mcp-method");

      log.push(
        `${called ?? new URL(sent.url).pathname} ${sent.headers.get("authorization") ?? "signed out"}: ${response.status}`
      );

      return response;
    };

    return { web, log, fetch };
  };

  it.each([
    {
      resource: "http://localhost:3000/mcp",
      discovery: "/.well-known/oauth-protected-resource/mcp",
    },
    {
      resource: "http://localhost:3000",
      discovery: "/.well-known/oauth-protected-resource",
    },
  ])(
    "serves a signed-out caller its listing and public tools, signs the official client in on a protected one, and steps it up for a write's scope, the resource being $resource",
    async ({ resource, discovery }) => {
      const { log, fetch } = mcpBehindInMemoryOAuthServer(resource);

      const client = new Client(
        { name: "test", version: "0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } }
      );

      try {
        await client.connect(
          new StreamableHTTPClientTransport(
            new URL("http://localhost:3000/mcp"),
            {
              fetch: async (input, init) =>
                await fetch(new Request(input, init)),
              authProvider: new ClientCredentialsProvider({
                clientId: "host",
                clientSecret: "secret",
                expectedIssuer: issuer,
              }),
            }
          )
        );

        const listed = await client.listTools();
        const status = await client.callTool({ name: "status", arguments: {} });

        const renamed = await client.callTool({
          name: "renameUser",
          arguments: { id: "1", name: "OAuth" },
        });

        expect(listed.tools.map((tool) => tool.name)).toStrictEqual([
          "status",
          "getUser",
          "renameUser",
          "whoAmI",
          "listChanges",
          "double",
        ]);
        expect(status.structuredContent).toStrictEqual({
          service: "effect-actions",
          users: 2,
        });
        expect(renamed.structuredContent).toStrictEqual({
          id: "1",
          name: "OAuth",
        });
      } finally {
        await client.close();
      }

      expect(log).toStrictEqual([
        "server/discover signed out: 200",
        "tools/list signed out: 200",
        "status signed out: 200",
        "renameUser signed out: 401",
        `${discovery} signed out: 200`,
        `token users:read for ${resource}`,
        "renameUser Bearer reader: 403",
        `${discovery} signed out: 200`,
        `token users:read users:write for ${resource}`,
        "renameUser Bearer alice: 200",
      ]);
    }
  );
});
