import { expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  ErrorReporter,
  Exit,
  Fiber,
  Option,
  Schema,
  Scope,
} from "effect";
import { KeyValueStore } from "effect/persistence";
import { TestClock } from "effect/testing";

import { WebhookSecret } from "../../src/contract/callback.js";
import { makeWriteBehindStorage } from "../../src/webhook/stored.js";
import type { Stored } from "../../src/webhook/stored.js";
import { recorder } from "../support/reporter.js";
import { secretOf, settled } from "../support/webhook.js";

const record: Stored = {
  url: new URL("https://hooks.example.com/alice"),
  event: "user.changed",
  input: {},
  identity: { id: "alice" },
  secret: Schema.decodeSync(WebhookSecret)(secretOf(1)),
  expiresAt: 60 * 60 * 1000,
  watermark: "3",
  status: { active: true, lastDeliveryAt: null, lastError: null },
};

it.effect(
  "writes what is marked as the layer closes, before its writer has run",
  () =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;
      const scope = yield* Scope.make();

      const storage = yield* makeWriteBehindStorage(store).pipe(
        Scope.provide(scope)
      );

      storage.mark("sub_alice", record);

      yield* Scope.close(scope, Exit.void);

      const reopened = yield* makeWriteBehindStorage(store);

      expect(reopened.ids()).toStrictEqual(["sub_alice"]);
      expect(yield* reopened.get("sub_alice")).toStrictEqual(
        Option.some(record)
      );
    }).pipe(Effect.scoped, Effect.provide(KeyValueStore.layerMemory))
);

const key = "effect-actions/webhook/sub_alice";

interface Outage {
  down: boolean;
  writes: number;
  held: Deferred.Deferred<undefined> | undefined;
}

const failingWhileDown = (store: KeyValueStore.KeyValueStore) => {
  const state: Outage = { down: false, writes: 0, held: undefined };

  const write = <A>(
    written: Effect.Effect<A, KeyValueStore.KeyValueStoreError>,
    at: string
  ) =>
    Effect.suspend(() => {
      state.writes += 1;

      const failed = new KeyValueStore.KeyValueStoreError({
        message: "The store is down",
        method: "write",
        key: at,
      });

      return Effect.andThen(
        state.held === undefined ? Effect.void : Deferred.await(state.held),
        state.down ? Effect.fail(failed) : written
      );
    });

  return {
    state,
    store: KeyValueStore.make({
      get: store.get,
      getUint8Array: store.getUint8Array,
      set: (at, value) => write(store.set(at, value), at),
      remove: (at) => write(store.remove(at), at),
      clear: store.clear,
      size: store.size,
      keys: store.keys,
    }),
  };
};

it.effect(
  "writes a removal again whose write failed, once a later mark or the close comes",
  () =>
    Effect.gen(function* () {
      const memory = yield* KeyValueStore.KeyValueStore;
      const { state, store } = failingWhileDown(memory);
      const scope = yield* Scope.make();

      const storage = yield* makeWriteBehindStorage(store).pipe(
        Scope.provide(scope)
      );

      storage.mark("sub_alice", record);

      yield* settled(() => state.writes === 2);

      state.down = true;
      storage.mark("sub_alice", undefined);

      yield* settled(() => state.writes === 3);
      yield* settled();

      const once = state.writes;

      storage.mark("sub_bob", undefined);

      yield* settled(() => state.writes > once);

      const again = state.writes;

      state.down = false;

      yield* Scope.close(scope, Exit.void);

      const reopened = yield* makeWriteBehindStorage(memory);

      expect([once, again]).toStrictEqual([3, 5]);
      expect(reopened.ids()).toStrictEqual([]);
      expect(yield* memory.has(key)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(KeyValueStore.layerMemory))
);

it.effect("keeps a mark made as an earlier one of its id is written", () =>
  Effect.gen(function* () {
    const memory = yield* KeyValueStore.KeyValueStore;
    const { state, store } = failingWhileDown(memory);
    const scope = yield* Scope.make();

    const storage = yield* makeWriteBehindStorage(store).pipe(
      Scope.provide(scope)
    );

    const held = yield* Deferred.make<undefined>();

    state.held = held;
    storage.mark("sub_alice", record);

    yield* settled(() => state.writes === 1);

    storage.mark("sub_alice", undefined);
    state.held = undefined;

    yield* Deferred.succeed(held, undefined);
    yield* Scope.close(scope, Exit.void);

    const reopened = yield* makeWriteBehindStorage(memory);

    expect(reopened.ids()).toStrictEqual([]);
    expect(yield* memory.has(key)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(KeyValueStore.layerMemory))
);

it.effect(
  "reports the subscriptions still unwritten 5 seconds into the layer's close, and closes",
  () => {
    const reported: string[] = [];

    return Effect.gen(function* () {
      const memory = yield* KeyValueStore.KeyValueStore;
      const scope = yield* Scope.make();

      const hanging = KeyValueStore.make({
        get: memory.get,
        getUint8Array: memory.getUint8Array,
        set: () => Effect.never,
        remove: () => Effect.never,
        clear: memory.clear,
        size: memory.size,
        keys: memory.keys,
      });

      const storage = yield* makeWriteBehindStorage(hanging).pipe(
        Scope.provide(scope)
      );

      storage.mark("sub_alice", record);

      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));

      yield* TestClock.adjust("4 seconds");

      const reportedEarly = reported.length;

      yield* TestClock.adjust("1 second");
      yield* Fiber.join(closing);

      expect(reportedEarly).toBe(0);
      expect(reported).toHaveLength(1);
      expect(reported[0]).toContain("sub_alice");
    }).pipe(
      Effect.provide([
        KeyValueStore.layerMemory,
        ErrorReporter.layer([recorder(reported)]),
      ])
    );
  }
);
