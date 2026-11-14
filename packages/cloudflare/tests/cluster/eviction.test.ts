import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster";
import { describe, expect, it } from "@effect/vitest";
import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Fiber, Stream } from "effect";

import { invokedSince, stubs } from "../support/socket.js";
import { asAlice, throughWorker } from "../support/worker.js";
import { Seen } from "../worker.js";

describe("Stored.layerEvents in an entity on workerd", () => {
  it.live(
    "keeps a log source's occurrences across the object's eviction, for a watch resumed from a cursor before them",
    () =>
      Effect.gen(function* () {
        const client = yield* asAlice;
        const room = "evicted";

        const { finished } = yield* stubs;

        const first = yield* client
          .watch(Seen, { room })
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

        yield* invokedSince(finished.invoke);
        yield* client.whoami({ room });

        const [seen] = yield* Fiber.join(first);

        yield* client.whoami({ room });

        yield* Effect.promise(async () => {
          await evictDurableObject(
            env.CLUSTER_ENTITY.getByName(
              CloudflareCluster.encodeName("Seer", room)
            )
          );
        });

        const resumed = yield* client
          .watch(Seen, { room }, { cursor: seen?.cursor ?? null })
          .pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.timeout("10 seconds")
          );

        expect(seen).toMatchObject({
          _tag: "Occurrence",
          data: { by: "alice" },
        });
        expect(resumed).toMatchObject([
          { _tag: "Occurrence", data: { by: "alice" } },
        ]);
        expect(resumed[0]?.cursor).not.toBe(seen?.cursor);
      }).pipe(Effect.provide(throughWorker)),
    { timeout: 30_000 }
  );
});
