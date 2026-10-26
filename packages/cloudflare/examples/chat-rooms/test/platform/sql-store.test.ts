import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "@effect/vitest";
import { Clock, Effect, Layer } from "effect";
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { MessageNotFound, NotAuthor } from "../../src/chat/Chat.js";
import { MessageStore } from "../../src/chat/store.js";
import { layerSql } from "../../src/platform/sql-store.js";

const day = 24 * 60 * 60 * 1000;

let objects = 0;

// The adapter against a room's real SQLite database, inside a fresh object of its own: what it
// reaches is the Workers runtime, so the runtime is its stand-in.
const inObject = <A, E>(
  use: (store: MessageStore["Service"], state: DurableObjectState) => Effect.Effect<A, E>,
) =>
  Effect.promise(() =>
    runInDurableObject(env.CHAT_ROOM.getByName(`sql-store-${objects++}`), (_, state) =>
      Effect.runPromise(
        MessageStore.use((store) => use(store, state)).pipe(
          Effect.provide(
            layerSql.pipe(
              Layer.provide(ActionDurableObject.Alarm.layer),
              Layer.provide(Layer.succeed(ActionDurableObject.State, state)),
            ),
          ),
        ),
      ),
    ),
  );

// A clock a millisecond later at each read, which never yields: posts running at once read
// times of their own, where at one shared time the oldest message and the latest would set the
// same alarm. Effect's TestClock moves on through a semaphore, which lets each post finish first.
const tickingFrom = (start: number): Clock.Clock => {
  let now = start;
  const tick = () => (now += 1);
  const nanos = () => BigInt(now) * 1_000_000n;

  return {
    currentTimeMillisUnsafe: tick,
    currentTimeMillis: Effect.sync(tick),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: nanos,
    monotonicTimeNanos: Effect.sync(nanos),
    sleep: () => Effect.void,
  };
};

describe("layerSql", () => {
  it.live("numbers a room's messages and reads those after an id", () =>
    inObject((store) =>
      Effect.gen(function* () {
        const first = yield* store.post("ada", "One.");
        const second = yield* store.post("grace", "Two.");

        expect(second.id).toBe(first.id + 1);
        expect(yield* store.read(0)).toEqual([first, second]);
        expect(yield* store.read(first.id)).toEqual([second]);
        expect(yield* store.latest).toEqual(second);
      }),
    ),
  );

  it.live("deletes only its author's message", () =>
    inObject((store) =>
      Effect.gen(function* () {
        const posted = yield* store.post("ada", "Mine.");

        expect(yield* Effect.flip(store.remove("grace", posted.id))).toEqual(
          new NotAuthor({ id: posted.id }),
        );
        expect(yield* Effect.flip(store.remove("ada", posted.id + 1))).toEqual(
          new MessageNotFound({ id: posted.id + 1 }),
        );

        yield* store.remove("ada", posted.id);

        expect(yield* store.latest).toBeNull();
      }),
    ),
  );

  it.live("sets the alarm for the oldest message's expiry when messages are posted at once", () =>
    inObject((store, state) =>
      Effect.gen(function* () {
        const posted = yield* Effect.forEach(
          Array.from({ length: 32 }, (_, i) => `Message ${i}.`),
          (text) => store.post("ada", text),
          { concurrency: "unbounded" },
        ).pipe(Effect.provideService(Clock.Clock, tickingFrom(Date.now())));

        expect(new Set(posted.map(({ at }) => at)).size).toBe(32);
        expect(yield* Effect.promise(() => state.storage.getAlarm())).toBe(
          Math.min(...posted.map(({ at }) => at)) + day,
        );
      }),
    ),
  );

  it.live("sets the alarm for the first message's expiry and leaves it for later ones", () =>
    inObject((store, state) =>
      Effect.gen(function* () {
        const first = yield* store.post("ada", "One.");

        yield* Effect.sleep("1 millis");

        const second = yield* store.post("ada", "Two.");

        expect(second.at).toBeGreaterThan(first.at);
        expect(yield* Effect.promise(() => state.storage.getAlarm())).toBe(first.at + day);
      }),
    ),
  );
});
