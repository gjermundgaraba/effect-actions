import { describe, expect, it } from "@effect/vitest";
import { exports } from "cloudflare:workers";
import { Clock, Effect, Fiber, Schema } from "effect";

import { clientOver, opened } from "../support/socket.js";
import { asAlice, throughWorker } from "../support/worker.js";
import { Seer } from "../worker.js";

const Builds = Schema.Struct({ builds: Schema.Int });

const builds = (path: "/stall" | "/release") =>
  Effect.promise(async (): Promise<unknown> => {
    const response = await exports.default.fetch(
      `https://worker.example${path}`
    );

    return await response.json();
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Builds)), Effect.orDie);

describe("ActionCluster.initializer", () => {
  it.live(
    "serves an object and the Worker's waiting request through the build that replaced one stalled past 15 seconds",
    () =>
      Effect.gen(function* () {
        const before = yield* builds("/stall");

        const waiting = yield* Effect.forkChild(
          Effect.flatMap(asAlice, (seer) =>
            seer.whoami({ room: "stalled" })
          ).pipe(Effect.provide(throughWorker))
        );

        yield* Effect.sleep("1 second");

        const asked = yield* Clock.currentTimeMillis;

        const socket = yield* opened("Seer", "replaced", {
          authorization: "Bearer alice",
        });

        const waited = (yield* Clock.currentTimeMillis) - asked;

        const seer = yield* clientOver(Seer.binding, socket);
        const overSocket = yield* seer.readHeaders({ room: "replaced" });

        const released = yield* builds("/release");
        const overHttp = yield* Fiber.join(waiting);

        expect(before.builds).toBe(0);
        expect(waited).toBeGreaterThanOrEqual(13_000);
        expect(released.builds).toBe(2);
        expect([overSocket.headers["authorization"], overHttp]).toStrictEqual([
          "Bearer alice",
          "Bearer alice",
        ]);
      }).pipe(Effect.scoped),
    { timeout: 60_000 }
  );
});
