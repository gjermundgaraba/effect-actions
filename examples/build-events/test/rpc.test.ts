import { describe, expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Effect, Fiber, Layer, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { TestClock } from "effect/testing";

import { BuildFinished } from "../src/builds/Builds.js";
import { routes } from "../src/routes.js";
import { Rpc } from "../src/Rpc.js";
import { inMemory } from "./support/memory.js";

const served = RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provide(Testing.layer(routes)),
  Layer.provide(inMemory())
);

const as = (token: string) =>
  RpcClient.withHeaders({ authorization: `Bearer ${token}` });

describe("the service, over RPC", () => {
  it.effect("streams each build a member may see, as a call finishes it", () =>
    Effect.gen(function* () {
      const client = yield* ActionRpc.client(Rpc);

      const watched = yield* client
        .watch(BuildFinished)
        .pipe(Stream.take(1), Stream.runCollect, as("grace"), Effect.forkChild);

      yield* TestClock.adjust("0 millis");
      yield* client
        .finishBuild({ pipeline: "api", status: "passed" })
        .pipe(as("ada"));
      yield* client
        .finishBuild({ pipeline: "web", status: "passed" })
        .pipe(as("ada"));

      expect(yield* Fiber.join(watched)).toMatchObject([
        { _tag: "Occurrence", data: { id: "build-2", pipeline: "web" } },
      ]);
    }).pipe(Effect.scoped, Effect.provide(served))
  );

  it.effect(
    "refuses a watch without a member's token, as its typed failure",
    () =>
      Effect.gen(function* () {
        const client = yield* ActionRpc.client(Rpc);

        expect(
          yield* Effect.flip(Stream.runDrain(client.watch(BuildFinished))).pipe(
            as("mallory")
          )
        ).toBeInstanceOf(Action.Unauthenticated);
      }).pipe(Effect.scoped, Effect.provide(served))
  );

  it.effect(
    "streams each step of a build a member starts, then the build",
    () =>
      Effect.gen(function* () {
        const client = yield* ActionRpc.client(Rpc);
        const steps: string[] = [];

        const build = yield* client
          .startBuild(
            { pipeline: "api" },
            { onProgress: ({ step }) => Effect.sync(() => steps.push(step)) }
          )
          .pipe(as("ada"));

        expect([steps, build]).toStrictEqual([
          ["install", "build", "test"],
          { id: "build-1", pipeline: "api", status: "passed" },
        ]);
      }).pipe(Effect.scoped, Effect.provide(served))
  );
});
