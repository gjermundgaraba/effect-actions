import * as Webhook from "@gjermundgaraba/effect-actions/Webhook";
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

import type { Schedule } from "./alarm.js";
import { batches } from "./batches.js";
import { State } from "./state.js";

export const clockOwner = "webhooks";

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

export const makeWaits = (schedule: Schedule) => {
  const held = new Set<Wait>();
  const arming = Semaphore.makeUnsafe(1);

  const armForEarliestWait = arming.withPermits(1)(
    Effect.suspend(() =>
      held.size === 0
        ? schedule.clear(clockOwner)
        : schedule.set(clockOwner, Math.min(...[...held].map(({ at }) => at)))
    )
  );

  return {
    waits: Waits.of({
      until: (at) =>
        Effect.suspend(() => {
          const wait: Wait = { at, woken: Deferred.makeUnsafe() };

          held.add(wait);

          return Effect.andThen(
            armForEarliestWait,
            Deferred.await(wait.woken)
          ).pipe(
            Effect.ensuring(
              Effect.suspend(() =>
                held.delete(wait) ? armForEarliestWait : Effect.void
              )
            )
          );
        }),
    }),
    wakeDue: Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      for (const wait of held) {
        if (wait.at <= now) {
          held.delete(wait);
          Deferred.doneUnsafe(wait.woken, Exit.void);
        }
      }

      yield* armForEarliestWait;
    }),
  };
};

const alarmWaitThreshold = Duration.seconds(10);

const alarmClock = (
  base: Clock.Clock,
  { until }: Waits["Service"]
): Clock.Clock => ({
  currentTimeMillisUnsafe: () => base.currentTimeMillisUnsafe(),
  currentTimeMillis: base.currentTimeMillis,
  currentTimeNanosUnsafe: () => base.currentTimeNanosUnsafe(),
  currentTimeNanos: base.currentTimeNanos,
  monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: base.monotonicTimeNanos,
  sleep: (duration) =>
    Duration.isLessThan(duration, alarmWaitThreshold) ||
    !Duration.isFinite(duration)
      ? base.sleep(duration)
      : until(base.currentTimeMillisUnsafe() + Duration.toMillis(duration)),
});

const stringOf = Schema.decodeUnknownOption(Schema.String);

const attempted = <A>(
  method: string,
  key: string | undefined,
  run: () => Promise<A>
) =>
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

const keyOf = (key: string) => `${webhookPrefix}${key}`;

const storageStore = (storage: DurableObjectStorage) => {
  const listed = attempted(
    "list",
    undefined,
    async () => await storage.list({ prefix: webhookPrefix })
  );

  return KeyValueStore.makeStringOnly({
    get: (key) =>
      Effect.map(
        attempted("get", key, async () => await storage.get(keyOf(key))),
        (value) => Option.getOrUndefined(stringOf(value))
      ),
    set: (key, value) =>
      attempted("set", key, async () => {
        await storage.put(keyOf(key), value);
      }),
    remove: (key) =>
      Effect.asVoid(
        attempted("remove", key, async () => await storage.delete(keyOf(key)))
      ),
    clear: Effect.flatMap(listed, (found) =>
      Effect.forEach(
        batches([...found.keys()]),
        (keys) =>
          attempted(
            "clear",
            undefined,
            async () => await storage.delete([...keys])
          ),
        { discard: true }
      )
    ),
    size: Effect.map(listed, (found) => found.size),
  });
};

/** How `layerWebhooks` grants, verifies and retries: `Webhook.Options` but what it fixes. */
export type LayerWebhooksOptions = Omit<
  Webhook.Options,
  "persist" | "resolveCallbacks"
>;

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
  options: LayerWebhooksOptions = {}
): Layer.Layer<Webhooks, never, HttpClient.HttpClient | State | Waits> =>
  Webhook.layer({ ...options, persist: true, resolveCallbacks: false }).pipe(
    Layer.provide([
      Layer.effect(KeyValueStore.KeyValueStore)(
        Effect.map(State, ({ storage }) => storageStore(storage))
      ),
      Layer.effect(Clock.Clock)(
        Effect.map(Effect.all([Clock.Clock, Waits]), ([base, waits]) =>
          alarmClock(base, waits)
        )
      ),
    ])
  );
