import { describe, expect, it } from "@effect/vitest";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Effect, Exit, Layer, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";

import { Http } from "../../src/Api.js";
import { BuildNotFound } from "../../src/builds/Builds.js";
import { routes } from "../../src/routes.js";
import { Rpc } from "../../src/Rpc.js";
import { inMemory } from "../support/memory.js";

const served = Testing.layer(routes).pipe(Layer.provide(inMemory()));

const overRpc = RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provide(served)
);

const bearer = (token: string) =>
  HttpClient.mapRequest(HttpClientRequest.bearerToken(token));

const log = [
  { line: "install: passed" },
  { line: "build: passed" },
  { line: "test: passed" },
  { line: "passed" },
];

describe("a build's log", () => {
  it.effect("streams each line of a build over HTTP and RPC", () =>
    Effect.gen(function* () {
      const http = yield* ActionHttp.client(Http, {
        transformClient: bearer("ada"),
      });

      const rpc = yield* ActionRpc.client(Rpc);
      const { id } = yield* http.startBuild({ pipeline: "api" });

      // Each call returns a `Stream`: a line is read as the server sends it.
      const lines = [
        yield* Stream.runCollect(http.tailLog({ buildId: id })),
        yield* Stream.runCollect(rpc.tailLog({ buildId: id })).pipe(
          RpcClient.withHeaders({ authorization: "Bearer ada" })
        ),
      ];

      expect(lines).toStrictEqual([log, log]);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(served, overRpc)))
  );

  it.effect("is not found for a member who may not see its pipeline", () =>
    Effect.gen(function* () {
      const ada = yield* ActionHttp.client(Http, {
        transformClient: bearer("ada"),
      });

      const grace = yield* ActionHttp.client(Http, {
        transformClient: bearer("grace"),
      });

      const { id } = yield* ada.startBuild({ pipeline: "api" });

      expect(
        yield* Effect.exit(Stream.runDrain(grace.tailLog({ buildId: id })))
      ).toStrictEqual(Exit.fail(new BuildNotFound({ buildId: id })));
    }).pipe(Effect.provide(served))
  );
});
