import { Clock, DateTime, Duration, Effect, Latch, Schema } from "effect";
import { ClusterSchema, DeliverAt } from "effect/cluster";
import { Rpc } from "effect/rpc";

import { reported } from "../contract/reported.js";
import { Wake } from "../contract/wake.js";

export const wakeTag = "effect-actions/wake";

class WakeAt extends Schema.Class<WakeAt, { readonly brand: unique symbol }>(
  "effect-actions/ActionEntity/WakeAt"
)({ at: Schema.Int }) {
  [DeliverAt.symbol]() {
    return DateTime.makeUnsafe(this.at);
  }
}

export const WakeRpc = Rpc.make(wakeTag, { payload: WakeAt }).annotate(
  ClusterSchema.Persisted,
  true
);

export const makeWake = <E>(
  send: (wake: WakeAt) => Effect.Effect<unknown, E>
) =>
  Effect.map(Clock.Clock, (clock) => {
    const waiting = new Set<{
      readonly at: number;
      readonly woken: Latch.Latch;
    }>();

    const slept = (at: number) =>
      clock.sleep(
        Duration.millis(Math.max(at - clock.currentTimeMillisUnsafe(), 0))
      );

    const until = (at: number) =>
      Effect.suspend(() => {
        const waiter = { at, woken: Latch.makeUnsafe() };

        waiting.add(waiter);

        return Effect.raceFirst(
          waiter.woken.await,
          send(new WakeAt({ at })).pipe(
            Effect.matchCauseEffect({
              onSuccess: () => Effect.never,
              onFailure: (cause) => Effect.andThen(reported(cause), slept(at)),
            })
          )
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              waiting.delete(waiter);
            })
          )
        );
      });

    return {
      wake: Wake.of({ until }),
      woke: ({ payload }: { readonly payload: WakeAt }) =>
        Rpc.fork(
          Effect.sync(() => {
            for (const waiter of waiting) {
              if (waiter.at <= payload.at) {
                waiter.woken.openUnsafe();
              }
            }
          })
        ),
    };
  });
