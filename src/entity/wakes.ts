import {
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  Latch,
  Layer,
  PrimaryKey,
  Schema,
} from "effect";
import { ClusterSchema, DeliverAt } from "effect/cluster";
import { Headers } from "effect/http";
import { Rpc, RpcClient } from "effect/rpc";

import { reported } from "../contract/reported.js";

export const wakeTag = "effect-actions/wake";

class Wake extends Schema.Class<Wake, { readonly brand: unique symbol }>(
  "effect-actions/ActionEntity/Wake"
)({ at: Schema.Int }) {
  [PrimaryKey.symbol]() {
    return `wake-${this.at}`;
  }

  [DeliverAt.symbol]() {
    return DateTime.makeUnsafe(this.at);
  }
}

export const WakeRpc = Rpc.make(wakeTag, { payload: Wake }).annotate(
  ClusterSchema.Persisted,
  true
);

/**
 * The wakes of one entity activation, which `ActionEntity.layer` provides to its `services`, and
 * `layerClock` sleeps through.
 */
export class Wakes extends Context.Service<
  Wakes,
  { readonly until: (at: number) => Effect.Effect<void> }
>()("effect-actions/ActionEntity/Wakes") {}

export const makeWakes = <E>(send: (wake: Wake) => Effect.Effect<unknown, E>) =>
  Effect.map(Clock.Clock, (clock) => {
    const waiting = new Set<{
      readonly at: number;
      readonly woken: Latch.Latch;
    }>();

    const sentOrSlept = (at: number) =>
      send(new Wake({ at })).pipe(
        Effect.provideService(RpcClient.CurrentHeaders, Headers.empty),
        Effect.matchCauseEffect({
          onSuccess: () => Effect.never,
          onFailure: (cause) =>
            Effect.andThen(
              reported(cause),
              Effect.flatMap(clock.currentTimeMillis, (now) =>
                clock.sleep(Duration.millis(at - now))
              )
            ),
        })
      );

    return {
      wakes: Wakes.of({
        until: (at) =>
          Effect.suspend(() => {
            const waiter = { at, woken: Latch.makeUnsafe(false) };

            waiting.add(waiter);

            return Effect.raceFirst(waiter.woken.await, sentOrSlept(at)).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  waiting.delete(waiter);
                })
              )
            );
          }),
      }),
      woke: ({ payload }: { readonly payload: Wake }) =>
        Effect.sync(() => {
          for (const waiter of waiting) {
            if (waiter.at <= payload.at) {
              waiter.woken.openUnsafe();
            }
          }
        }),
    };
  });

const durableFrom = Duration.seconds(10);

class DurableClock implements Clock.Clock {
  readonly currentTimeMillis: Effect.Effect<number>;
  readonly currentTimeNanos: Effect.Effect<bigint>;
  readonly monotonicTimeNanos: Effect.Effect<bigint>;
  readonly #base: Clock.Clock;
  readonly #until: (at: number) => Effect.Effect<void>;

  constructor(base: Clock.Clock, until: (at: number) => Effect.Effect<void>) {
    this.#base = base;
    this.#until = until;
    this.currentTimeMillis = base.currentTimeMillis;
    this.currentTimeNanos = base.currentTimeNanos;
    this.monotonicTimeNanos = base.monotonicTimeNanos;
  }

  currentTimeMillisUnsafe(): number {
    return this.#base.currentTimeMillisUnsafe();
  }

  currentTimeNanosUnsafe(): bigint {
    return this.#base.currentTimeNanosUnsafe();
  }

  monotonicTimeNanosUnsafe(): bigint {
    return this.#base.monotonicTimeNanosUnsafe();
  }

  sleep(duration: Duration.Duration): Effect.Effect<void> {
    if (
      Duration.isLessThan(duration, durableFrom) ||
      !Duration.isFinite(duration)
    ) {
      return this.#base.sleep(duration);
    }

    const due =
      this.#base.currentTimeMillisUnsafe() + Duration.toMillis(duration);

    return this.#until(Math.ceil(due / 1000) * 1000);
  }
}

/**
 * A `Clock` for an entity's `services` whose sleeps of 10 seconds or more are a persisted tell the
 * entity sends itself, due when the sleep ends, so the entity may stop meanwhile and is built again
 * when it is due: give it to `Webhook.layer` with `persist`, whose retry waits then outlast the
 * activation. Requires `Wakes`, which `ActionEntity.layer` provides to its `services`.
 */
export const layerClock: Layer.Layer<never, never, Wakes> = Layer.effect(
  Clock.Clock
)(
  Effect.gen(function* () {
    const base = yield* Clock.Clock;
    const { until } = yield* Wakes;

    return new DurableClock(base, until);
  })
);
