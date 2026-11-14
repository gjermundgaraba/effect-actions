import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster";
import { describe, expect, it } from "@effect/vitest";
import * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Fiber, Stream } from "effect";
import { RpcClient } from "effect/rpc";

import { invokedSince, stubs } from "../support/socket.js";
import {
  asAlice,
  gathered,
  logged,
  received,
  throughWorker,
} from "../support/worker.js";
import { initialize, Seer, Seen } from "../worker.js";

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

const receivedUntil = (count: number, tag: string) =>
  Effect.map(
    gathered(
      received,
      (calls) => calls.filter((call) => call.tag === tag).length >= count
    ),
    (calls) => calls.filter((call) => call.tag === tag)
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

const tagged = (tag: string) => (line: string) => line.startsWith(`["${tag}"`);

const loggedUntil = (count: number, tag: string) =>
  Effect.map(
    gathered(logged, (lines) => lines.filter(tagged(tag)).length >= count),
    (lines) => lines.filter(tagged(tag))
  );

describe("ActionCluster.layer's entity clients", () => {
  it.live(
    "send a caller's authorization through ActionEntity.reaching exactly, while the entity's logs and the Worker's redact it",
    () =>
      Effect.gen(function* () {
        yield* logged;

        const client = yield* asAlice;
        const steps: number[] = [];

        const { finished } = yield* stubs;

        const watching = yield* client
          .watch(Seen, { room: "a" })
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

        yield* invokedSince(finished.invoke);

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

        const seer = yield* Effect.provideContext(
          ActionEntity.client(Seer),
          context
        );

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
