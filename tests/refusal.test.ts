import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Option, Redacted } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import * as Action from "../src/Action.js";
import * as Authentication from "../src/Authentication.js";
import { authenticate } from "../examples/authentication.js";
import { admit } from "../examples/authentication-upgrade.js";
import { serve } from "./serve.js";

class Caller extends Context.Service<Caller, string>()("refusal/Caller") {}

const resource = {
  resource: "https://api.example.com/mcp?tenant=alice\\",
  authorizationServers: ["https://auth.example.com"],
  scopesRequired: ["docs:read"],
} satisfies Authentication.Options;

const metadata =
  "https://api.example.com/.well-known/oauth-protected-resource/mcp?tenant=alice\\\\";

/** What a client reads of a refusal. */
const read = async (response: Response) => ({
  status: response.status,
  body: await response.text(),
  contentType: response.headers.get("content-type"),
  cacheControl: response.headers.get("cache-control"),
  challenge: response.headers.get("www-authenticate"),
});

/** `error` as `make` answers it, refusing a request whose header is `authorization`. */
const routed = (
  error: Action.Refusal,
  authorization: string | undefined,
  protectedResource: Authentication.Options | undefined,
) =>
  serve(
    HttpRouter.add("GET", "/private", Effect.map(Caller, HttpServerResponse.text)).pipe(
      Layer.provide(
        Authentication.make(Caller, Effect.succeed(Effect.fail(error)), protectedResource).layer,
      ),
    ),
  ).handler(
    new Request(
      "https://api.example.com/private",
      authorization === undefined ? {} : { headers: { authorization } },
    ),
  );

const scoped = new Action.Forbidden({ message: "Requires docs:write.", scopes: ["docs:write"] });

describe("refusal", () => {
  it.for([
    ["a 401 without credentials", new Action.Unauthenticated(), undefined],
    ["a 401 to a bearer token", new Action.Unauthenticated({ message: "Expired." }), "Bearer x"],
    ["a 401 to a lowercase scheme", new Action.Unauthenticated(), "bearer x"],
    ["a 401 to two tokens, which is no bearer token", new Action.Unauthenticated(), "Bearer a b"],
    ["a 401 to another scheme", new Action.Unauthenticated(), "Basic eA=="],
    ["a 403 naming scopes", scoped, "Bearer x"],
    [
      "a 403 whose message is no RFC 6750 description",
      new Action.Forbidden({ message: 'Needs "write".', scopes: ["docs:write"] }),
      "Bearer x",
    ],
    ["a 403 naming no scopes", new Action.Forbidden({ message: "Not yours." }), "Bearer x"],
  ] as const)("answers %s as make does, with and without a resource", async ([, error, header]) => {
    for (const protectedResource of [undefined, resource]) {
      const outside = HttpServerResponse.toWeb(
        Authentication.refusal(error, { protectedResource, authorization: header }),
      );

      expect(await read(outside)).toEqual(
        await read(await routed(error, header, protectedResource)),
      );
    }
  });

  it("answers a 401 with its JSON, no-store and the resource's challenge, its metadata URL escaped", async () => {
    const anonymous = Authentication.refusal(new Action.Unauthenticated(), {
      protectedResource: resource,
    });

    expect(await read(HttpServerResponse.toWeb(anonymous))).toEqual({
      status: 401,
      body: '{"_tag":"Unauthenticated","message":"Authentication is required."}',
      contentType: "application/json",
      cacheControl: "no-store",
      challenge: `Bearer scope="docs:read", resource_metadata="${metadata}"`,
    });

    const presented = Authentication.refusal(new Action.Unauthenticated(), {
      protectedResource: resource,
      authorization: "Bearer x",
    });

    expect(presented.headers["www-authenticate"]).toBe(
      `Bearer error="invalid_token", scope="docs:read", resource_metadata="${metadata}"`,
    );
  });

  it("answers a 403 naming scopes with insufficient_scope, and one naming none without a challenge", () => {
    const stepUp = Authentication.refusal(scoped, { protectedResource: resource });

    expect(stepUp.status).toBe(403);
    expect(stepUp.headers["cache-control"]).toBe("no-store");
    expect(stepUp.headers["www-authenticate"]).toBe(
      `Bearer error="insufficient_scope", scope="docs:write", resource_metadata="${metadata}", error_description="Requires docs:write."`,
    );

    const plain = Authentication.refusal(new Action.Forbidden({ message: "Not yours." }));

    expect(plain.status).toBe(403);
    expect(plain.headers["www-authenticate"]).toBeUndefined();
  });

  it("names no resource without one: a bare Bearer challenge", () => {
    expect(Authentication.refusal(new Action.Unauthenticated()).headers["www-authenticate"]).toBe(
      "Bearer",
    );
  });

  it("refuses a scopesRequired that is no scope token, as make does", () => {
    const invalid = { ...resource, scopesRequired: ["docs read"] } satisfies Authentication.Options;

    expect(() =>
      Authentication.refusal(new Action.Unauthenticated(), { protectedResource: invalid }),
    ).toThrow('Invalid scope in scopesRequired: "docs read"');
  });
});

describe("bearerTokenOf", () => {
  it.for([
    [undefined, undefined],
    ["alice", undefined],
    ["Bearer alice", "alice"],
    ["Bearer alice ", "alice"],
    ["bearer alice", "alice"],
    ["Bearer a b", undefined],
    ["Basic x", undefined],
  ] as const)("reads %s", ([header, token]) => {
    expect(
      Option.getOrUndefined(Option.map(Authentication.bearerTokenOf(header), Redacted.value)),
    ).toBe(token);
  });
});

describe("the upgrade example", () => {
  it.for([
    undefined,
    "alice",
    "Bearer alice",
    "Bearer alice ",
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

    // The example's own authentication, around a route.
    const response = await serve(
      HttpRouter.add("GET", "/private", HttpServerResponse.empty()).pipe(
        Layer.provide(authenticate),
      ),
    ).handler(
      new Request(
        "http://localhost:3000/private",
        header === undefined ? {} : { headers: { authorization: header } },
      ),
    );

    expect(admitted).toEqual({
      status: response.status === 204 ? 200 : response.status,
      challenge: response.headers.get("www-authenticate"),
    });
  });
});
