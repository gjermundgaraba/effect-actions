import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
  Semaphore,
} from "effect";
import type { HttpClient } from "effect/http";
import { KeyValueStore } from "effect/persistence";
import * as Webhook from "@gjermundgaraba/effect-actions/Webhook";
import type { Schedule } from "./alarm.js";
import { batches } from "./batches.js";
import { State } from "./state.js";

/** The owner of the object's alarm times that end its long waits. */
export const clockOwner = "webhooks";

/**
 * Where `layerWebhooks` keeps its subscriptions in the object's storage: every key of its store,
 * whatever layout `Webhook.layer`'s `persist` gives them, is under it.
 */
export const webhookPrefix = "effect-actions/webhooks/";

type Webhooks = Layer.Success<ReturnType<typeof Webhook.layer>>;

/**
 * The instance's long waits, which the object's alarm ends: `until(at)` waits until the alarm
 * runs at or after `at`, holding no timer, so the object may hibernate meanwhile. `handlers` and
 * `make` provide it to the routes, over the instance's schedule, for `layerWebhooks`.
 */
export class Waits extends Context.Service<
  Waits,
  { readonly until: (at: number) => Effect.Effect<void> }
>()("effect-actions-cloudflare/ActionDurableObject/Waits") {}

interface Wait {
  readonly at: number;
  readonly woken: Deferred.Deferred<void>;
}

/**
 * The instance's `Waits`, their time set on `schedule`, the one its `alarm` handler runs, and
 * `wakeDue`, which that handler runs at their time.
 */
export const makeWaits = (schedule: Schedule) => {
  const held = new Set<Wait>();
  const arming = Semaphore.makeUnsafe(1);

  // Why: the time is read from the waits as it is written, one write at a time, so the alarm is
  // set for the earliest wait held then, whichever order the writes of several waits are run in:
  // the schedule's own lock serializes the writes, not the reads before them. With none held, the
  // time is cleared, so a wait ended early, as a refresh ends its subscription's expiry, leaves no
  // wake for nothing.
  const armed = arming.withPermits(1)(
    Effect.suspend(() =>
      held.size === 0
        ? schedule.clear(clockOwner)
        : schedule.set(clockOwner, Math.min(...[...held].map(({ at }) => at))),
    ),
  );

  return {
    waits: Waits.of({
      until: (at) =>
        Effect.suspend(() => {
          const wait: Wait = { at, woken: Deferred.makeUnsafe() };

          held.add(wait);

          return Effect.andThen(armed, Deferred.await(wait.woken)).pipe(
            Effect.ensuring(Effect.suspend(() => (held.delete(wait) ? armed : Effect.void))),
          );
        }),
    }),
    /** Ends each wait that is due, and sets the alarm for the next. */
    wakeDue: Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      for (const wait of held) {
        if (wait.at <= now) {
          held.delete(wait);
          Deferred.doneUnsafe(wait.woken, Exit.void);
        }
      }

      yield* armed;
    }),
  };
};

// Why: a wait under 10 seconds, such as a POST's timeout, keeps its timer, which holds the object
// awake no longer than the work it bounds; a longer one, a retry's backoff or a subscription's
// expiry, holds none, which would keep the object from hibernating, or from eviction, for as long
// as it lasts, and is ended by the object's alarm instead. One without end has no time to wake at.
const timed = Duration.seconds(10);

// Why: Effect derives no Clock from another, and the ones it makes keep their methods on a class
// or in a closure, which a spread would drop, so each is passed through.
/**
 * The Clock the webhook layer runs on: a wait of 10 seconds or more waits on the object's alarm
 * and holds no timer, so the object may hibernate meanwhile; if the instance is evicted, the
 * alarm builds the next, which restores the subscriptions from storage.
 */
const alarmClock = (base: Clock.Clock, { until }: Waits["Service"]): Clock.Clock => ({
  currentTimeMillisUnsafe: () => base.currentTimeMillisUnsafe(),
  currentTimeMillis: base.currentTimeMillis,
  currentTimeNanosUnsafe: () => base.currentTimeNanosUnsafe(),
  currentTimeNanos: base.currentTimeNanos,
  monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: base.monotonicTimeNanos,
  sleep: (duration) =>
    Duration.isLessThan(duration, timed) || !Duration.isFinite(duration)
      ? base.sleep(duration)
      : until(base.currentTimeMillisUnsafe() + Duration.toMillis(duration)),
});

// Why: a value under these keys is one the webhook layer wrote, a string; any other reads as none.
const stringOf = Schema.decodeUnknownOption(Schema.String);

const attempted = <A>(method: string, key: string | undefined, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new KeyValueStore.KeyValueStoreError({
        message: `The object's storage failed to ${method}`,
        method,
        ...(key === undefined ? {} : { key }),
        cause,
      }),
  });

/** A `KeyValueStore` over the object's storage under `webhookPrefix`, every key of it there. */
const storageStore = (storage: DurableObjectStorage) => {
  const keyOf = (key: string) => `${webhookPrefix}${key}`;
  const listed = attempted("list", undefined, () => storage.list({ prefix: webhookPrefix }));

  return KeyValueStore.makeStringOnly({
    get: (key) =>
      Effect.map(
        attempted("get", key, () => storage.get(keyOf(key))),
        (value) => Option.getOrUndefined(stringOf(value)),
      ),
    set: (key, value) => attempted("set", key, () => storage.put(keyOf(key), value)),
    remove: (key) => Effect.asVoid(attempted("remove", key, () => storage.delete(keyOf(key)))),
    clear: Effect.flatMap(listed, (found) =>
      Effect.forEach(
        batches([...found.keys()]),
        (keys) => attempted("clear", undefined, () => storage.delete([...keys])),
        { discard: true },
      ),
    ),
    size: Effect.map(listed, (found) => found.size),
  });
};

/** How `layerWebhooks` grants, verifies and retries: `Webhook.Options` but what it fixes. */
export type LayerWebhooksOptions = Omit<Webhook.Options, "persist" | "resolveCallbacks">;

/**
 * The core's `Webhook.layer` in an object: each subscription kept in the object's storage, under
 * `effect-actions/webhooks/`, restored as the object builds after an eviction, and each wait of 10
 * seconds or more, a retry's backoff or a subscription's expiry, ended by the object's alarm, so
 * the object hibernates between deliveries and wakes to retry one. Provide it to the routes
 * beside the surfaces offering webhooks, with an `HttpClient` for the deliveries; its `Waits` are
 * the instance's, which `handlers` and `make` provide.
 *
 * **Gotchas**
 *
 * - A callback's name is not resolved for the address check, as Workers have no resolver: a literal address is checked, and a name is left to Cloudflare's egress, which reaches no private network of yours without a Tunnel or a VPC binding of your own.
 * - A delivery in flight when the instance is evicted is sent again by the next, from the subscription's last kept position: a subscriber drops the repeat by its `eventId`.
 * - A protected event offered by webhook needs its authentication's `schema`, as `Webhook.Options`' `persist` says: the subscriber's identity is kept by it, not authenticated again at a wake.
 * - The subscriptions live beside the application's data: a store deleting every key deletes them too, and a subscriber hears nothing more.
 * - Call it once per object and provide that Layer to every surface offering webhooks: two calls are two layers over one store, each losing the other's subscriptions at an eviction.
 * - The source, authorizer and client a delivery runs share its Clock: a wait of 10 seconds or more in them, a timeout included, waits on the object's alarm, holding no timer.
 */
export const layerWebhooks = (
  options: LayerWebhooksOptions = {},
): Layer.Layer<Webhooks, never, HttpClient.HttpClient | State | Waits> =>
  Webhook.layer({ ...options, persist: true, resolveCallbacks: false }).pipe(
    Layer.provide(
      Layer.effect(KeyValueStore.KeyValueStore)(
        Effect.map(State, ({ storage }) => storageStore(storage)),
      ),
    ),
    Layer.provide(
      Layer.effect(Clock.Clock)(
        Effect.map(Effect.all([Clock.Clock, Waits]), ([base, waits]) => alarmClock(base, waits)),
      ),
    ),
  );
