import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Http } from "../../src/Api.js";
import { StartBuild } from "../../src/builds/Builds.js";
import { Login } from "../../src/identity/Identity.js";
import { routes } from "../../src/routes.js";
import { inMemory } from "../support/memory.js";

const served = Testing.layer(routes).pipe(Layer.provide(inMemory()));

const bearer = (token: string) => HttpClient.mapRequest(HttpClientRequest.bearerToken(token));

const steps = [
  { step: "install", done: 0, total: 3 },
  { step: "build", done: 1, total: 3 },
  { step: "test", done: 2, total: 3 },
];

describe("a build started by a member", () => {
  it.effect("reports each step to a caller that asks, over HTTP and MCP, then answers", () =>
    Effect.gen(function* () {
      const http = yield* ActionHttp.client(Http, { transformClient: bearer("ada") });

      const mcp = yield* ActionMcp.client([StartBuild], {
        authentication: Login,
        transformClient: bearer("ada"),
      });

      const seen: Array<unknown> = [];
      const onProgress = (step: (typeof steps)[number]) => Effect.sync(() => seen.push(step));

      // A caller asks for the steps by giving `onProgress`; without it, the call answers alone.
      const answers = [
        yield* http.startBuild({ pipeline: "api" }, { onProgress }),
        yield* mcp.startBuild({ pipeline: "api" }, { onProgress }),
      ];

      expect(seen).toEqual([...steps, ...steps]);
      expect(answers).toEqual([
        { id: "build-1", pipeline: "api", status: "passed" },
        { id: "build-2", pipeline: "api", status: "passed" },
      ]);
    }).pipe(Effect.provide(served)),
  );
});
