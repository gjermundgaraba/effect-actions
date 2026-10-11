import { describe, expect, it } from "@effect/vitest";
import { Array, Effect, flow, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Http } from "../../src/Api.js";
import { Directory } from "../../src/identity/directory.js";
import { IssuerUnavailable, QuotaExceeded, WhoAmI } from "../../src/identity/Identity.js";
import { memory } from "../../src/memory.js";
import { publicRoutes } from "../../src/routes.js";

// What authentication adds on the wire: the public port behind its real providers, answering
// in memory. A caller is the credential its client sends.
const served = Testing.layer(publicRoutes).pipe(Layer.provide(memory));

// A test replaces the one service it is about. Provided before `memory`, this layer is the
// `Directory` the routes are built with; `memory` gives them the rest.
const servedWith = (directory: Layer.Layer<Directory>) =>
  Testing.layer(publicRoutes).pipe(Layer.provide(directory), Layer.provide(memory));

// A directory that cannot reach its issuer.
const issuerDown = Layer.succeed(
  Directory,
  Directory.of({
    ofToken: () => Effect.fail(new IssuerUnavailable({ retryAfterSeconds: 30 })),
    ofSession: () => Effect.fail(new Action.Unauthenticated()),
  }),
);

const as = (token: string, workspace: string) => ({
  transformClient: HttpClient.mapRequest(
    flow(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setHeader("x-workspace", workspace),
    ),
  ),
});

describe("a bearer token", () => {
  it.effect("makes the caller the member it is in the workspace the request names", () =>
    Effect.gen(function* () {
      const atAcme = yield* ActionHttp.client(Http, as("ada", "acme"));
      const atGlobex = yield* ActionHttp.client(Http, as("ada", "globex"));
      const elsewhere = yield* ActionHttp.client(Http, as("linus", "globex"));

      expect(yield* atAcme.whoAmI()).toMatchObject({ workspace: "acme" });
      expect(yield* atGlobex.whoAmI()).toEqual({
        id: "ada",
        workspace: "globex",
        scopes: ["issues:read"],
      });

      // A member of acme alone, asking for globex: refused, with no scope to step up to.
      const refused = yield* Effect.flip(elsewhere.whoAmI());

      expect(refused).toBeInstanceOf(Action.Forbidden);
      expect(refused.message).toBe("Name a workspace you belong to in the X-Workspace header.");
    }).pipe(Effect.provide(served)),
  );

  it.effect(
    "is refused a write it lacks the scope for, by an error and a challenge naming it",
    () =>
      Effect.gen(function* () {
        const reader = yield* ActionHttp.client(Http, as("linus", "acme"));

        const refused = yield* Effect.flip(reader.createIssue({ title: "Crash", body: "" }));

        // `toEqual` compares an error's own fields, here `scopes`; never its `message`.
        expect(refused).toEqual(new Action.Forbidden({ scopes: ["issues:write"] }));
        expect(refused.message).toBe("Requires issues:write.");

        // The same refusal as sent: the 403 an OAuth client re-authorizes on.
        const response = yield* HttpClientRequest.post("/api/v1/closeIssue").pipe(
          HttpClientRequest.bearerToken("linus"),
          HttpClientRequest.setHeader("x-workspace", "acme"),
          HttpClientRequest.bodyJsonUnsafe({ id: "ACME-1" }),
          HttpClient.execute,
        );

        expect(response.status).toBe(403);
        expect(response.headers["www-authenticate"]).toContain(
          'error="insufficient_scope", scope="issues:write"',
        );
      }).pipe(Effect.provide(served)),
  );

  it.effect("finds where to sign in: published discovery, named in the challenge of a 401", () =>
    Effect.gen(function* () {
      const discovery = yield* HttpClient.get("/.well-known/oauth-protected-resource/mcp");

      expect(yield* discovery.json).toMatchObject({
        resource: "http://localhost:3000/mcp",
        scopes_supported: ["issues:read", "issues:write"],
      });

      // A protected tool's call without a token: the endpoint's own 401, before any tool runs.
      const refused = yield* HttpClient.execute(
        Testing.mcpRequest("tools/call", { name: "whoAmI", arguments: {} }),
      );

      expect(refused.status).toBe(401);
      expect(refused.headers["www-authenticate"]).toBe(
        'Bearer scope="issues:read", resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"',
      );
    }).pipe(Effect.provide(served)),
  );

  it.effect("fails with the verifier's declared error, a typed 503, when the issuer is down", () =>
    Effect.gen(function* () {
      const http = yield* ActionHttp.client(Http, as("ada", "acme"));
      const mcp = yield* Testing.mcpClient([WhoAmI], as("ada", "acme"));

      expect(yield* Effect.flip(http.whoAmI())).toEqual(
        new IssuerUnavailable({ retryAfterSeconds: 30 }),
      );
      // Over MCP it is the endpoint's HTTP answer, before any tool runs, not a tool's result:
      // the client fails with the error that holds such an answer.
      expect(yield* Effect.flip(mcp.whoAmI())).toBeInstanceOf(Testing.McpCallError);
    }).pipe(Effect.provide(servedWith(issuerDown))),
  );
});

describe("the request quota", () => {
  it.effect("is spent per member, and answered as the binding's typed error", () =>
    Effect.gen(function* () {
      const ada = yield* ActionHttp.client(Http, as("ada", "acme"));
      const grace = yield* ActionHttp.client(Http, as("grace", "globex"));

      yield* Effect.forEach(Array.range(1, 60), () => ada.whoAmI());

      expect(yield* Effect.flip(ada.whoAmI())).toBeInstanceOf(QuotaExceeded);
      expect(yield* grace.whoAmI()).toMatchObject({ id: "grace" });
    }).pipe(Effect.provide(served)),
  );
});
