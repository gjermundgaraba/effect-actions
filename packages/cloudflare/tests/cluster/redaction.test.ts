import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster";
import { describe, expect, it } from "@effect/vitest";
import * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { Effect, Fiber, Layer, Schedule, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { RpcClient } from "effect/rpc";

import { initialize, Seer, SeerHttp, Seen } from "../worker.js";

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

const storedRowsOf = (type: string, id: string) =>
  Effect.promise(
    async () =>
      await runInDurableObject(
        env.CLUSTER_ENTITY.getByName(CloudflareCluster.encodeName(type, id)),
        (_, state) =>
          state.storage.sql
            .exec<{ name: string }>(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\'"
            )
            .toArray()
            .flatMap(({ name }) =>
              state.storage.sql
                .exec(`SELECT * FROM ${name}`)
                .toArray()
                .map((row) => JSON.stringify(row))
            )
      )
  );

const logged = Effect.promise(
  async () => await exports.default.fetch("https://worker.example/logged")
).pipe(
  Effect.flatMap((response) =>
    Effect.promise(async () => await response.json())
  ),
  Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.String))),
  Effect.orDie
);

const Received = Schema.Array(
  Schema.Struct({
    tag: Schema.String,
    authorization: Schema.NullOr(Schema.String),
  })
);

const received = Effect.promise(
  async () => await exports.default.fetch("https://worker.example/received")
).pipe(
  Effect.flatMap((response) =>
    Effect.promise(async () => await response.json())
  ),
  Effect.flatMap(Schema.decodeUnknownEffect(Received)),
  Effect.orDie
);

const receivedUntil = (count: number, tag: string) =>
  received.pipe(
    Effect.map((calls) => calls.filter((call) => call.tag === tag)),
    Effect.repeat({
      until: (calls) => calls.length >= count,
      schedule: Schedule.spaced("50 millis"),
    }),
    Effect.timeout("10 seconds")
  );

const atRest = (...ids: readonly string[]) =>
  Effect.forEach(ids, (id) =>
    Effect.map(storedRowsOf("Seer", id), (rows) => {
      for (const row of rows) {
        expect(row).not.toContain("Bearer alice");
      }

      return rows;
    })
  );

const redacting = (lines: readonly string[]) => {
  for (const line of lines) {
    expect(line).not.toContain("Bearer alice");
    expect(line).toContain('"authorization":"<redacted>"');
  }
};

const loggedUntil = (count: number, tag: string) =>
  logged.pipe(
    Effect.map((lines) => lines.filter((line) => line.startsWith(`["${tag}"`))),
    Effect.repeat({
      until: (lines) => lines.length >= count,
      schedule: Schedule.spaced("50 millis"),
    }),
    Effect.timeout("10 seconds")
  );

describe("ActionCluster.layer's entity clients", () => {
  it.live(
    "send a caller's authorization through ActionEntity.reaching exactly, while the entity's logs and the Worker's redact it",
    () =>
      Effect.gen(function* () {
        yield* logged;

        const client = yield* asAlice;
        const steps: number[] = [];

        const watching = yield* client
          .watch(Seen, { room: "a" })
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

        yield* Effect.sleep("500 millis");

        const seen = yield* client.whoami(
          { room: "a" },
          { onProgress: ({ step }) => Effect.sync(() => steps.push(step)) }
        );

        const polled = yield* Fiber.join(watching);

        const lines = yield* logged;

        expect(seen).toBe("Bearer alice");
        expect(steps).toStrictEqual([1]);
        expect(polled).toMatchObject([{ data: { by: "alice" } }]);

        expect(
          lines.filter((line) => line.startsWith('["entity"'))
        ).toHaveLength(1);
        expect(
          lines.filter((line) => line.startsWith('["edge"')).length
        ).toBeGreaterThanOrEqual(2);

        for (const line of lines) {
          expect(line).not.toContain("Bearer alice");
        }

        for (const line of lines.filter((each) =>
          each.includes("authorization")
        )) {
          expect(line).toContain('"authorization":"<redacted>"');
        }

        const [stored = []] = yield* atRest("a");

        expect(stored.filter((row) => row.includes("alice"))).toHaveLength(1);
      }).pipe(Effect.provide(throughWorker)),
    { timeout: 30_000 }
  );

  it.live(
    "send an entity's call of another entity with a credential exactly, while both entities' logs redact it",
    () =>
      Effect.gen(function* () {
        yield* logged;

        const client = yield* asAlice;

        const { reached } = yield* client.relay({ room: "from", to: "to" });

        const lines = yield* logged;

        expect(reached).toBe("Bearer alice");
        expect(lines.filter((line) => line.startsWith('["read"'))).toHaveLength(
          1
        );
        expect(
          lines.filter((line) => line.startsWith('["relay"'))
        ).toHaveLength(1);
        redacting(
          lines.filter(
            (line) => line.startsWith('["read"') || line.startsWith('["relay"')
          )
        );
        yield* atRest("from", "to");
      }).pipe(Effect.provide(throughWorker)),
    { timeout: 30_000 }
  );

  it.live(
    "send an entity's call of itself with a credential through its own object, its log redacting it",
    () =>
      Effect.gen(function* () {
        yield* logged;
        yield* received;

        const client = yield* asAlice;

        expect(yield* client.relay({ room: "self", to: "self" })).toStrictEqual(
          { reached: null }
        );

        expect(yield* receivedUntil(1, "read")).toStrictEqual([
          { tag: "read", authorization: "Bearer alice" },
        ]);
        redacting(yield* loggedUntil(1, "read"));
        yield* atRest("self");
      }).pipe(Effect.provide(throughWorker)),
    { timeout: 30_000 }
  );

  it.live(
    "send a call made outside any request with a credential exactly, while the entity's log redacts it",
    () =>
      Effect.gen(function* () {
        yield* logged;

        const context = yield* Effect.promise(
          async () => await initialize(env)
        );

        const seer = (yield* Effect.provideContext(
          ActionEntity.client(Seer),
          context
        ))("outside");

        const { headers } = yield* seer
          .readHeaders({ room: "outside" })
          .pipe(RpcClient.withHeaders({ authorization: "Bearer alice" }));

        const lines = yield* logged;

        expect(headers["authorization"]).toBe("Bearer alice");
        expect(lines.filter((line) => line.startsWith('["read"'))).toHaveLength(
          1
        );
        redacting(lines);
        yield* atRest("outside");
      }),
    { timeout: 30_000 }
  );

  it.live(
    "send a persisted tell's credential redacted, so neither its handler nor cluster_messages holds it",
    () =>
      Effect.gen(function* () {
        yield* received;

        const context = yield* Effect.promise(
          async () => await initialize(env)
        );

        const seer = (yield* Effect.provideContext(Seer.client, context))(
          "persisted"
        );

        yield* seer
          .note({ text: "kept" }, { discard: true })
          .pipe(RpcClient.withHeaders({ authorization: "Bearer alice" }));

        expect(yield* receivedUntil(1, "note")).toStrictEqual([
          { tag: "note", authorization: "<redacted>" },
        ]);

        const [stored = []] = yield* atRest("persisted");

        expect(
          stored.some((row) => row.includes(String.raw`\"tag\":\"note\"`))
        ).toBe(true);
      }),
    { timeout: 30_000 }
  );
});
