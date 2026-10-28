import { expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";

import { Approvers } from "../../src/deploys/approvers.js";
import { DeployRequested } from "../../src/deploys/Deploys.js";
import { deployEvents } from "../../src/deploys/events.js";
import { deploys } from "../../src/deploys/handlers.js";
import { as } from "../support/as.js";

it.effect(
  "delivers each deploy request to the subscribers of its environment, who stand by to approve it",
  () =>
    Effect.gen(function* () {
      const client = yield* Action.client([deploys, deployEvents]);

      const production = yield* client
        .watch(DeployRequested, { environment: "production" })
        .pipe(Stream.take(1), Stream.runCollect, as("grace"), Effect.forkChild);

      yield* TestClock.adjust("0 millis");

      const staging = yield* client
        .requestDeploy({ environment: "staging", version: "1.1.0" })
        .pipe(as("ada"));

      yield* client
        .requestDeploy({ environment: "production", version: "1.0.9" })
        .pipe(as("ada"));

      expect(staging.approvers).toStrictEqual([]);
      expect(yield* Fiber.join(production)).toMatchObject([
        {
          data: {
            environment: "production",
            version: "1.0.9",
            requestedBy: "ada",
            approvers: ["grace"],
          },
        },
      ]);

      const later = yield* client
        .requestDeploy({ environment: "production", version: "1.1.0" })
        .pipe(as("ada"));

      expect(later.approvers).toStrictEqual([]);
    }).pipe(Effect.provide([Approvers.layerMemory, Event.layerMemory]))
);
