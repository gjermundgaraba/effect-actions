import { expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";

import { BuildFinished } from "../../src/builds/Builds.js";
import { buildEvents } from "../../src/builds/events.js";
import { builds } from "../../src/builds/handlers.js";
import { BuildStore } from "../../src/builds/store.js";
import { as } from "../support/as.js";

it.effect(
  "delivers each build a member may see as it finishes, as the subscription selects",
  () =>
    Effect.gen(function* () {
      // One client holds both: the action that finishes builds and the event that reports them.
      const client = yield* Action.client([builds, buildEvents]);

      const failed = yield* client
        .watch(BuildFinished, { status: "failed" })
        .pipe(Stream.take(1), Stream.runCollect, as("grace"), Effect.forkChild);

      // The watch starts from now: let it take its first position before builds finish.
      yield* TestClock.adjust("0 millis");
      yield* client
        .finishBuild({ pipeline: "api", status: "failed" })
        .pipe(as("ada"));
      yield* client
        .finishBuild({ pipeline: "web", status: "passed" })
        .pipe(as("ada"));
      // Each build finished notifies: the watch reads at once, with no wait for its next poll.
      yield* client
        .finishBuild({ pipeline: "web", status: "failed" })
        .pipe(as("ada"));

      // grace sees only the web pipeline, and asked only for failures.
      expect(yield* Fiber.join(failed)).toMatchObject([
        {
          _tag: "Occurrence",
          data: { id: "build-3", pipeline: "web", status: "failed" },
        },
      ]);
    }).pipe(Effect.provide([BuildStore.layerMemory, Event.layerMemory]))
);

it.effect(
  "sends a gap first to a subscriber resuming from a cursor the store never gave",
  () =>
    Effect.gen(function* () {
      const client = yield* Action.client([builds, buildEvents]);

      yield* client
        .finishBuild({ pipeline: "web", status: "passed" })
        .pipe(as("ada"));

      // A cursor of the store before a restart, its offset one this store has too: what it named
      // is gone, so the watch is told.
      const resumed = yield* client
        .watch(BuildFinished, {}, { cursor: "an-earlier-epoch:0" })
        .pipe(Stream.take(2), Stream.runCollect, as("grace"));

      expect(resumed).toMatchObject([
        { _tag: "Gap" },
        { _tag: "Occurrence", data: { id: "build-1", pipeline: "web" } },
      ]);
    }).pipe(Effect.provide([BuildStore.layerMemory, Event.layerMemory]))
);
