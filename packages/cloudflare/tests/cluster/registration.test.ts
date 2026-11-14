import { describe, expect, it } from "@effect/vitest";
import { exports } from "cloudflare:workers";
import { Effect, Exit, Fiber, Schema } from "effect";

import { eventually } from "../support/eventually.js";
import { asAlice, throughWorker } from "../support/worker.js";

const Builds = Schema.Struct({
  builds: Schema.Int,
  finished: Schema.Int,
  disposed: Schema.Int,
});

const builds = (path: "/stall-above" | "/release") =>
  Effect.promise(async (): Promise<unknown> => {
    const response = await exports.default.fetch(
      `https://worker.example${path}`
    );

    return await response.json();
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Builds)), Effect.orDie);

const whoami = (room: string) =>
  Effect.flatMap(asAlice, (seer) => seer.whoami({ room })).pipe(
    Effect.provide(throughWorker),
    Effect.timeout("30 seconds"),
    Effect.exit
  );

describe("ActionCluster.initializer, a build stalled above ActionCluster.layer", () => {
  it.live(
    "serves the entities the stalled build registered after it finishes behind its replacement",
    () =>
      Effect.gen(function* () {
        const before = yield* builds("/stall-above");
        const waiting = yield* Effect.forkChild(whoami("stalled"));

        yield* Effect.sleep("16 seconds");

        const replaced = yield* whoami("replaced");

        yield* builds("/release");

        const late = yield* builds("/stall-above").pipe(
          eventually(({ finished }) => finished === 2)
        );

        const stalled = yield* Fiber.join(waiting);
        const after = yield* whoami("after");

        expect(before.builds).toBe(0);
        expect([stalled, replaced, after].map(Exit.isSuccess)).toStrictEqual([
          true,
          true,
          true,
        ]);
        expect(late).toStrictEqual({ builds: 2, finished: 2, disposed: 0 });
      }),
    { timeout: 60_000 }
  );
});
