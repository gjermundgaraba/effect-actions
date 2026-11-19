import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster";
import { describe, expect, it } from "@effect/vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Fiber } from "effect";

import { gathered, received } from "../support/worker.js";
import { context, Seer } from "../worker.js";

const tags = Effect.map(received, (all) => all.map(({ tag }) => tag));

const receivedTag = (tag: string) => gathered(tags, (all) => all.includes(tag));

describe("ActionEntity.layer's native rpcs on workerd", () => {
  it.live(
    "read ActionCluster.ObjectState, the object's own state, in the build and per call, its waitUntil holding work past the answer",
    () =>
      Effect.gen(function* () {
        const built = yield* Effect.promise(async () => await context(env));

        const seers = yield* Effect.provideContext(Seer.client, built);

        yield* received;

        const state = yield* seers("state-a").state();
        const waited = yield* receivedTag("waited");

        expect(state).toStrictEqual({
          name: CloudflareCluster.encodeName("Seer", "state-a"),
          built: true,
        });
        expect(waited).toContain("waited");
      }),
    { timeout: 30_000 }
  );

  it.live(
    "run ObjectState's database.transaction behind the mailbox's gate, so a persisted reply written while it is open lands after it and survives its rollback, and reject with the closure's own rejection",
    () =>
      Effect.gen(function* () {
        const built = yield* Effect.promise(async () => await context(env));

        const seers = yield* Effect.provideContext(Seer.client, built);

        yield* received;

        const parked = yield* Effect.forkChild(
          seers("transactions-a").parked()
        );

        yield* receivedTag("parked");

        expect(yield* seers("transactions-a").transactions()).toStrictEqual({
          notes: ["kept"],
          rejectedAsThrown: true,
        });

        yield* Fiber.join(parked);

        const replies = yield* Effect.promise(
          async () =>
            await runInDurableObject(
              env.CLUSTER_ENTITY.getByName(
                CloudflareCluster.encodeName("Seer", "transactions-a")
              ),
              (_, state) =>
                state.storage.sql
                  .exec<{ kind: string }>("SELECT kind FROM cluster_replies")
                  .toArray()
            )
        );

        expect(replies).toStrictEqual([{ kind: "WithExit" }]);
      }),
    { timeout: 30_000 }
  );

  it.live(
    "build services per entity id for their handlers, and run a handler answering through Rpc.fork beside the entity's other calls",
    () =>
      Effect.gen(function* () {
        const built = yield* Effect.promise(async () => await context(env));

        const seers = yield* Effect.provideContext(Seer.client, built);

        expect(yield* seers("natives-a").bump()).toBe(1);
        expect(yield* seers("natives-a").bump()).toBe(2);
        expect(yield* seers("natives-b").bump()).toBe(1);

        yield* received;
        yield* Effect.forkChild(seers("natives-fork").hold());
        yield* receivedTag("holding");

        expect(
          yield* seers("natives-fork").bump().pipe(Effect.timeout("1 second"))
        ).toBe(1);
      }),
    { timeout: 30_000 }
  );

  it.live(
    "finish a handler answering through Rpc.uninterruptible after its caller is interrupted, where a plain one stops",
    () =>
      Effect.gen(function* () {
        const built = yield* Effect.promise(async () => await context(env));

        const seers = yield* Effect.provideContext(Seer.client, built);

        const interrupting = (id: string, uninterruptible: boolean) =>
          Effect.gen(function* () {
            yield* received;

            const call = yield* Effect.forkChild(
              seers(`natives-${id}`).mark({ id, uninterruptible })
            );

            const started = yield* receivedTag(`marking-${id}`);

            yield* Fiber.interrupt(call);

            return started;
          });

        const kept = yield* interrupting("kept", true);
        const finished = [...kept, ...(yield* receivedTag("mark-kept"))];

        const stopped = yield* interrupting("stopped", false);

        yield* seers("natives-stopped").bump();

        const marked = [...stopped, ...(yield* tags)];

        expect(finished.filter((tag) => tag === "mark-kept")).toHaveLength(1);
        expect(marked.filter((tag) => tag === "mark-stopped")).toHaveLength(0);
      }),
    { timeout: 30_000 }
  );
});
