import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster";
import { describe, expect, it } from "@effect/vitest";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { evictDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { Effect, Fiber, Layer, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { SeerHttp, Seen } from "../worker.js";

const throughWorker = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.Fetch)(
      async (input, init) =>
        await exports.default.fetch(new Request(input, init))
    )
  )
);

const asAlice = ActionHttp.client(SeerHttp, {
  baseUrl: "https://worker.example",
  transformClient: HttpClient.mapRequest(
    HttpClientRequest.bearerToken("alice")
  ),
});

describe("Stored.layerEvents in an entity on workerd", () => {
  it.live(
    "keeps a log source's occurrences across the object's eviction, for a watch resumed from a cursor before them",
    () =>
      Effect.gen(function* () {
        const client = yield* asAlice;
        const room = "evicted";

        const first = yield* client
          .watch(Seen, { room })
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

        yield* Effect.sleep("500 millis");
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
