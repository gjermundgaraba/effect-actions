import { describe, expect, it } from "@effect/vitest";
import { Cause, Context, Effect, Exit, Layer, Option, Redacted, Schema } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder, HttpApiSecurity } from "effect/http-api";
import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as Authentication from "../../src/authentication/Authentication.js";
import { authenticate } from "../../examples/authentication.js";
import { admit } from "../../examples/authentication-upgrade.js";
import { authorize, CurrentActor } from "../../examples/authorization.js";
import { Login } from "../../examples/binding.js";
import { answerStepUp, recordStepUp } from "../../src/authentication/refusal.js";
import { post } from "../support/requests.js";
import { serve } from "../support/serve.js";

class Caller extends Context.Service<Caller, string>()("refusal/Caller") {}

const CallerLogin = Authentication.make("refusal.CallerLogin", Caller);

const Private = Action.make("private", {
  description: "Signed in only",
  readOnly: true,
  caller: Caller,
  success: Schema.String,
});

const answering = Action.implement(Private, () => Caller, { authorize: Action.allowAll });

const resource = {
  resource: "https://api.example.com/mcp?tenant=alice\\",
  authorizationServers: ["https://auth.example.com"],
  scopesRequired: ["docs:read"],
} satisfies Authentication.ProtectedResource;

const metadata =
  "https://api.example.com/.well-known/oauth-protected-resource/mcp?tenant=alice\\\\";

const readAsClient = async (response: Response) => ({
  status: response.status,
  body: await response.text(),
  contentType: response.headers.get("content-type"),
  cacheControl: response.headers.get("cache-control"),
  challenge: response.headers.get("www-authenticate"),
});

const answeredByProtectedRoute = (
  error: Action.Refusal,
  authorization: string | undefined,
  protectedResource: Authentication.ProtectedResource | undefined,
) => {
  const request = new Request("https://api.example.com/api/private", post("/api/private"));

  if (authorization !== undefined) request.headers.set("authorization", authorization);

  return serve(
    ActionHttp.layer(ActionHttp.make([Private], { authentication: CallerLogin }), answering).pipe(
      Layer.provide(
        Authentication.layer(
          CallerLogin,
          () => Effect.fail(error),
          protectedResource === undefined ? {} : { protectedResource },
        ),
      ),
    ),
  ).handler(request);
};

const refusedBeforeVerifier = new Action.Unauthenticated({
  message: "A bearer token is required.",
});

const scoped = new Action.Forbidden({ message: "Requires docs:write.", scopes: ["docs:write"] });

describe("refusal", () => {
  it.for([
    ["a 401 without credentials", refusedBeforeVerifier, undefined],
    ["a 401 to a bearer token", new Action.Unauthenticated({ message: "Expired." }), "Bearer x"],
    ["a 401 to a lowercase scheme", new Action.Unauthenticated(), "bearer x"],
    ["a 401 to a token holding a space, `a b`", new Action.Unauthenticated(), "Bearer a b"],
    ["a 401 to another scheme", refusedBeforeVerifier, "Basic eA=="],
    ["a 403 naming scopes", scoped, "Bearer x"],
    [
      "a 403 whose message is no RFC 6750 description",
      new Action.Forbidden({ message: 'Needs "write".', scopes: ["docs:write"] }),
      "Bearer x",
    ],
    ["a 403 naming no scopes", new Action.Forbidden({ message: "Not yours." }), "Bearer x"],
  ] as const)(
    "answers %s as a protected route does, with and without a resource",
    async ([, error, header]) => {
      for (const protectedResource of [undefined, resource]) {
        const outside = HttpServerResponse.toWeb(
          Authentication.refusalResponse(error, { protectedResource, authorization: header }),
        );

        expect(await readAsClient(outside)).toEqual(
          await readAsClient(await answeredByProtectedRoute(error, header, protectedResource)),
        );
      }
    },
  );

  it("answers a 401 with its JSON, no-store and the resource's challenge, its metadata URL escaped", async () => {
    const anonymous = Authentication.refusalResponse(new Action.Unauthenticated(), {
      protectedResource: resource,
    });

    expect(await readAsClient(HttpServerResponse.toWeb(anonymous))).toEqual({
      status: 401,
      body: '{"_tag":"Unauthenticated","message":"Authentication is required."}',
      contentType: "application/json",
      cacheControl: "no-store",
      challenge: `Bearer scope="docs:read", resource_metadata="${metadata}"`,
    });

    const presented = Authentication.refusalResponse(new Action.Unauthenticated(), {
      protectedResource: resource,
      authorization: "Bearer x",
    });

    expect(presented.headers["www-authenticate"]).toBe(
      `Bearer error="invalid_token", scope="docs:read", resource_metadata="${metadata}"`,
    );
  });

  it("answers a 403 naming scopes with insufficient_scope, and one naming none without a challenge", () => {
    const stepUp = Authentication.refusalResponse(scoped, { protectedResource: resource });

    expect(stepUp.status).toBe(403);
    expect(stepUp.headers["cache-control"]).toBe("no-store");
    expect(stepUp.headers["www-authenticate"]).toBe(
      `Bearer error="insufficient_scope", scope="docs:write", resource_metadata="${metadata}", error_description="Requires docs:write."`,
    );

    const plain = Authentication.refusalResponse(new Action.Forbidden({ message: "Not yours." }));

    expect(plain.status).toBe(403);
    expect(plain.headers["www-authenticate"]).toBeUndefined();
  });

  it("names no resource without one: a bare Bearer challenge", () => {
    expect(
      Authentication.refusalResponse(new Action.Unauthenticated()).headers["www-authenticate"],
    ).toBe("Bearer");
  });

  it("refuses a scopesRequired that is no scope token, as Authentication.layer does", () => {
    const invalid = {
      ...resource,
      scopesRequired: ["docs read"],
    } satisfies Authentication.ProtectedResource;

    expect(() =>
      Authentication.refusalResponse(new Action.Unauthenticated(), { protectedResource: invalid }),
    ).toThrow('Invalid scope in scopesRequired: "docs read"');
  });

  it("refuses a scopesSupported that is no scope token, as Authentication.layer does", () => {
    const invalid = {
      ...resource,
      scopesSupported: ["docs:read", "docs write"],
    } satisfies Authentication.ProtectedResource;

    expect(() =>
      Authentication.refusalResponse(new Action.Unauthenticated(), { protectedResource: invalid }),
    ).toThrow('Invalid scope in scopesSupported: "docs write"');
  });

  it("refuses a resource with a fragment, a bare `#` included, which its discovery would never answer, as Authentication.layer does", () => {
    const fragment = {
      ...resource,
      resource: `${resource.resource}#tools`,
    } satisfies Authentication.ProtectedResource;

    const message = `A protected resource has no fragment: ${fragment.resource}`;

    expect(() =>
      Authentication.refusalResponse(new Action.Unauthenticated(), { protectedResource: fragment }),
    ).toThrow(message);
    expect(() =>
      Authentication.layer(CallerLogin, () => Effect.succeed("alice"), {
        protectedResource: fragment,
      }),
    ).toThrow(message);

    const bareHashResource = { ...resource, resource: `${resource.resource}#` };
    expect(() =>
      Authentication.refusalResponse(new Action.Unauthenticated(), {
        protectedResource: bareHashResource,
      }),
    ).toThrow(`A protected resource has no fragment: ${bareHashResource.resource}`);
  });

  it("refuses a protected resource under another scheme, as Authentication.layer does", () => {
    const Session = Authentication.make("refusal.Session", Caller, {
      security: HttpApiSecurity.apiKey({ in: "cookie", key: "session" }),
    });

    expect(() =>
      Authentication.refusalResponse(new Action.Unauthenticated(), {
        authentication: Session,
        protectedResource: resource,
      }),
    ).toThrow("A protected resource is published only for a Bearer scheme");
  });
});

describe("a step-up refusal answering its request", () => {
  const stepUp = recordStepUp(Effect.fail(new Action.Forbidden({ scopes: ["write"] })));

  it.effect("answers an MCP request however it ended, its tool's failure being a result", () =>
    Effect.gen(function* () {
      const answered = yield* answerStepUp(
        Effect.catch(stepUp, () => Effect.succeed(HttpServerResponse.empty())),
        undefined,
      );

      expect(answered.status).toBe(403);
      expect((yield* answerStepUp(stepUp, undefined)).status).toBe(403);
    }),
  );

  it.effect("keeps a defect after the refusal as the request's own", () =>
    Effect.gen(function* () {
      const broken = yield* Effect.exit(
        answerStepUp(Effect.ensuring(stepUp, Effect.die("finalizer")), undefined),
      );

      expect(Exit.isFailure(broken) && Cause.hasDies(broken.cause)).toBe(true);
    }),
  );
});

describe("the Refusal and BuiltIn schemas", () => {
  class Throttled extends Schema.TaggedError<Throttled>()("Throttled", {}) {}

  it("tell a refusal and a built-in failure apart from an error of the application's", () => {
    const errors = [
      new Action.Unauthenticated(),
      new Action.Forbidden(),
      new Action.InvalidInput(),
      new Throttled(),
    ];

    expect(errors.map(Schema.is(Action.Refusal))).toEqual([true, true, false, false]);
    expect(errors.map(Schema.is(Action.BuiltIn))).toEqual([true, true, true, false]);
  });
});

describe("bearerTokenOf", () => {
  const headers = [
    undefined,
    "",
    "alice",
    "Bearer",
    "Bearer ",
    "Bearer   ",
    "Bearer alice",
    "Bearer alice ",
    " Bearer alice",
    "Bearer  alice",
    "bearer alice",
    "BEARER alice",
    "Bearer a b",
    "Bearer\talice",
    "Bearer \talice",
    "Bearer alice\t",
    "Bearerx alice",
    "Basic x",
  ];

  it.for([
    ["Bearer alice", "alice"],
    ["Bearer alice ", "alice"],
    ["bearer alice", "alice"],
    ["Bearer a b", "a b"],
    ["Bearer", undefined],
    ["alice", undefined],
    ["Basic x", undefined],
  ] as const)("reads %s", ([header, token]) => {
    expect(
      Option.getOrUndefined(Option.map(Authentication.bearerTokenOf(header), Redacted.value)),
    ).toBe(token);
  });

  it.effect("reads a header as Effect's own Bearer scheme reads a request's", () =>
    Effect.gen(function* () {
      for (const header of headers) {
        const request = new Request("http://localhost/", {
          headers: header === undefined ? {} : { authorization: header },
        });

        const native = yield* HttpApiBuilder.securityDecode(HttpApiSecurity.bearer).pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(request),
          ),
          Effect.provideService(HttpServerRequest.ParsedSearchParams, {}),
        );

        const token = Authentication.bearerTokenOf(request.headers.get("authorization"));

        expect([header, Option.getOrElse(Option.map(token, Redacted.value), () => "")]).toEqual([
          header,
          Redacted.value(native),
        ]);
      }
    }),
  );
});

describe("the upgrade example", () => {
  const Write = Action.make("write", {
    description: "Write",
    readOnly: false,
    caller: CurrentActor,
  });

  const writingAuthorizedAsAdmit = Action.implement(Write, () => Effect.void, { authorize });

  it.for([
    undefined,
    "alice",
    "Bearer alice",
    "Bearer alice ",
    "Bearer reader",
    "bearer alice",
    "Bearer a b",
    "Basic x",
  ])("admits %s as the example's routes do", async (header) => {
    const admitted = await Effect.runPromise(
      Effect.match(admit(header), {
        onFailure: (response) => ({
          status: response.status,
          challenge: response.headers.get("www-authenticate"),
        }),
        onSuccess: () => ({ status: 200, challenge: null }),
      }),
    );

    const request = post("/api/write");

    if (header !== undefined) request.headers.set("authorization", header);

    const response = await serve(
      ActionHttp.layer(
        ActionHttp.make([Write], { authentication: Login }),
        writingAuthorizedAsAdmit,
      ).pipe(Layer.provide(authenticate)),
    ).handler(request);

    expect(admitted).toEqual({
      status: response.status,
      challenge: response.headers.get("www-authenticate"),
    });
  });
});
