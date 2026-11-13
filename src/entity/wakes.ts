import {
  Clock,
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Layer,
  PrimaryKey,
  Schema,
} from "effect";
import { ClusterSchema, DeliverAt } from "effect/cluster";
import { Rpc } from "effect/rpc";

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

const wakeTime = (at: number, now: number) => {
  let step = 1000;

  while (step * 32 <= at - now) {
    step *= 2;
  }

  return Math.floor(at / step) * step;
};

const durableFrom = Duration.seconds(10);

export const makeWakes = <E>(send: (wake: Wake) => Effect.Effect<unknown, E>) =>
  Effect.map(Clock.Clock, (clock) => {
    const waiting = new Set<{
      readonly due: number;
      readonly woken: Deferred.Deferred<number>;
    }>();

    const sleptUntil = (at: number) =>
      clock.sleep(
        Duration.millis(Math.max(at - clock.currentTimeMillisUnsafe(), 0))
      );

    const sentOrSlept = (due: number) =>
      send(new Wake({ at: due })).pipe(
        Effect.matchCauseEffect({
          onSuccess: () => Effect.never,
          onFailure: (cause) =>
            Effect.andThen(reported(cause), Effect.as(sleptUntil(due), due)),
        })
      );

    const wokenBy = (due: number) =>
      Effect.suspend(() => {
        const waiter = { due, woken: Deferred.makeUnsafe<number>() };

        waiting.add(waiter);

        return Effect.raceFirst(
          Deferred.await(waiter.woken),
          sentOrSlept(due)
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              waiting.delete(waiter);
            })
          )
        );
      });

    const sleptOn = (
      at: number,
      durable: "already" | "if long"
    ): Effect.Effect<void> =>
      Effect.suspend(() => {
        const now = clock.currentTimeMillisUnsafe();

        if (
          durable === "if long" &&
          at - now < Duration.toMillis(durableFrom)
        ) {
          return sleptUntil(at);
        }

        return Effect.flatMap(wokenBy(wakeTime(at, now)), (by) =>
          clock.currentTimeMillisUnsafe() < by
            ? Effect.void
            : sleptOn(at, "if long")
        );
      });

    return {
      wakes: Wakes.of({ until: (at) => sleptOn(at, "already") }),
      woke: ({ payload }: { readonly payload: Wake }) =>
        Rpc.fork(
          Effect.sync(() => {
            for (const waiter of waiting) {
              if (waiter.due <= payload.at) {
                Deferred.doneUnsafe(waiter.woken, Effect.succeed(payload.at));
              }
            }
          })
        ),
    };
  });

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

    return this.#until(
      this.#base.currentTimeMillisUnsafe() + Duration.toMillis(duration)
    );
  }
}

/**
 * A `Clock` for an entity's `services` whose sleeps of 10 seconds or more are persisted tells the
 * entity sends itself, so the entity may stop meanwhile and is built again when one is due: give
 * it to `Webhook.layer` with `persist`, whose retry waits then outlast the activation. Requires
 * `Wakes`, which `ActionEntity.layer` provides to its `services`.
 *
 * **Gotchas**
 *
 * - A long sleep's tell is due at a time sleeps ending near it share, before its end, and the sleep goes on from there: it never ends early, and an entity keeps at most 16 tells pending due within 16 seconds and 16 more for each doubling beyond, however many sleeps it starts.
 * - A tell delivered before its time, as a test moving its `deliver_at` delivers it, ends the sleeps it was sent for at once.
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
