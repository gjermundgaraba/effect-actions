import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { PipelineStatus } from "../../src/builds/Builds.js";
import { builds } from "../../src/builds/handlers.js";
import { statusEvents } from "../../src/builds/status.js";
import { BuildStore } from "../../src/builds/store.js";
import { as } from "../support/as.js";

it.effect(
  "sends a pipeline's status as it is, then as each of its builds ends, and nothing for another's",
  () =>
    Effect.gen(function* () {
      const client = yield* Action.client([builds, statusEvents]);

      const watching = yield* client
        .watch(PipelineStatus, { pipeline: "web" })
        .pipe(Stream.take(3), Stream.runCollect, as("grace"), Effect.forkChild);

      yield* TestClock.adjust("0 millis");
      yield* client.finishBuild({ pipeline: "api", status: "failed" }).pipe(as("ada"));
      yield* TestClock.adjust("0 millis");
      yield* client.finishBuild({ pipeline: "web", status: "failed" }).pipe(as("ada"));
      yield* TestClock.adjust("0 millis");
      yield* client.finishBuild({ pipeline: "web", status: "passed" }).pipe(as("ada"));

      expect(yield* Fiber.join(watching)).toMatchObject([
        { _tag: "Occurrence", data: { status: null } },
        { _tag: "Occurrence", data: { status: "failed" } },
        { _tag: "Occurrence", data: { status: "passed" } },
      ]);
    }).pipe(Effect.provide([BuildStore.layerMemory, Event.layerMemory])),
);
