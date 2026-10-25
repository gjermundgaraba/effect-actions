import { Clock, Deferred, Duration, Effect, Exit, Layer, Option, Schema, Semaphore } from "effect";
import type { HttpClient } from "effect/http";
import { KeyValueStore } from "effect/persistence";
import * as Webhook from "@gjermundgaraba/effect-actions/Webhook";
import { makeSchedule } from "./alarm.js";
import { batches } from "./batches.js";
import { State } from "./state.js";

/** The owner of the object's alarm times that end the webhook layer's long waits. */
export const clockOwner = "webhooks";

/**
 * Where `layerWebhooks` keeps its subscriptions in the object's storage: every key of its store,
 * whatever layout `Webhook.layer`'s `persist` gives them, is under it.
 */
export const webhookPrefix = "effect-actions/webhooks/";

type Webhooks = Layer.Success<ReturnType<typeof Webhook.layer>>;

interface Wait {
  readonly at: number;
  readonly woken: Deferred.Deferred<void>;
}

interface Waiting {
  readonly waits: Set<Wait>;
  readonly arming: Semaphore.Semaphore;
}

// Why: the waits belong to the instance, as its fibers do, and the alarm handler that ends them
// is the object's, reached by `State` alone: a new instance starts with none, its webhook layer
// restoring each subscription from storage as it builds.
const waiting = new WeakMap<DurableObjectState, Waiting>();

const waitingOf = (state: DurableObjectState) => {
  const found = waiting.get(state);

  if (found !== undefined) return found;

  const made: Waiting = { waits: new Set(), arming: Semaphore.makeUnsafe(1) };

  waiting.set(state, made);

  return made;
};

// Why: the time is read from the waits as it is written, one write at a time, so the alarm is set
// for the earliest wait held then, whichever order the writes of several waits are run in.
const armed = (state: DurableObjectState, { waits, arming }: Waiting) =>
  arming.withPermits(1)(
    Effect.suspend(() =>
      waits.size === 0
        ? Effect.void
        : makeSchedule(state).set(clockOwner, Math.min(...[...waits].map(({ at }) => at))),
    ),
  );

// Why: a wait under 10 seconds, such as a POST's timeout, keeps its timer, which holds the object
// awake no longer than the work it bounds; a longer one, a retry's backoff or a subscription's
// expiry, holds none, which would keep the object from hibernating, or from eviction, for as long
// as it lasts, and is ended by the object's alarm instead.
const timed = Duration.seconds(10);

/**
 * The Clock the webhook layer runs on: a wait of 10 seconds or more sets the object's alarm for
 * its end and holds no timer, so the object may hibernate meanwhile; if the instance is evicted,
 * the alarm builds the next, which restores the subscriptions from storage.
 */
const alarmClock = (state: DurableObjectState, base: Clock.Clock): Clock.Clock => {
  const held = waitingOf(state);

  return {
    currentTimeMillisUnsafe: () => base.currentTimeMillisUnsafe(),
    currentTimeMillis: base.currentTimeMillis,
    currentTimeNanosUnsafe: () => base.currentTimeNanosUnsafe(),
    currentTimeNanos: base.currentTimeNanos,
    monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: base.monotonicTimeNanos,
    sleep: (duration) =>
      Duration.isLessThan(duration, timed)
        ? base.sleep(duration)
        : Effect.suspend(() => {
            const wait: Wait = {
              at: base.currentTimeMillisUnsafe() + Duration.toMillis(duration),
              woken: Deferred.makeUnsafe(),
            };

            held.waits.add(wait);

            return Effect.andThen(armed(state, held), Deferred.await(wait.woken)).pipe(
              Effect.ensuring(Effect.sync(() => held.waits.delete(wait))),
            );
          }),
  };
};

/**
 * Ends each of the instance's waits due by its alarm, `scheduledTime` or now, whichever is later,
 * and sets the alarm for the next.
 */
export const wakeDue = (state: DurableObjectState, scheduledTime: number) =>
  Effect.gen(function* () {
    const held = waiting.get(state);

    if (held === undefined) return;

    const dueBy = Math.max(yield* Clock.currentTimeMillis, scheduledTime);

    for (const wait of held.waits) {
      if (wait.at <= dueBy) {
        held.waits.delete(wait);
        Deferred.doneUnsafe(wait.woken, Exit.void);
      }
    }

    yield* armed(state, held);
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
 * beside the surfaces offering webhooks, with an `HttpClient` for the deliveries.
 *
 * **Gotchas**
 *
 * - A callback's name is not resolved for the address check, as Workers have no resolver: a literal address is checked, and a name is left to Cloudflare's egress, which reaches no private network of yours without a Tunnel or a VPC binding of your own.
 * - A delivery in flight when the instance is evicted is sent again by the next, from the subscription's last kept position: a subscriber drops the repeat by its `eventId`.
 * - A protected event offered by webhook needs its authentication's `schema`, as `Webhook.Options`' `persist` says: the subscriber's identity is kept by it, not authenticated again at a wake.
 * - The subscriptions live beside the application's data: a store deleting every key deletes them too, where `wipe` keeps them.
 * - Only `make`'s and `handlers`' `alarm` ends its long waits: in a class whose `alarm` does not delegate to them, a delivery is never retried past its first wait of 10 seconds or more, and a subscription never ends at its expiry.
 * - Call it once per object and provide that Layer to every surface offering webhooks: two calls are two layers over one store, each losing the other's subscriptions at an eviction.
 * - The source, authorizer and client a delivery runs share its Clock: a wait of 10 seconds or more in them, a timeout included, sets the object's alarm, and one ended early leaves a wake for nothing.
 */
export const layerWebhooks = (
  options: LayerWebhooksOptions = {},
): Layer.Layer<Webhooks, never, HttpClient.HttpClient | State> =>
  Webhook.layer({ ...options, persist: true, resolveCallbacks: false }).pipe(
    Layer.provide(
      Layer.effect(KeyValueStore.KeyValueStore)(
        Effect.map(State, ({ storage }) => storageStore(storage)),
      ),
    ),
    Layer.provide(
      Layer.effect(Clock.Clock)(
        Effect.map(Effect.all([State, Clock.Clock]), ([state, base]) => alarmClock(state, base)),
      ),
    ),
  );
