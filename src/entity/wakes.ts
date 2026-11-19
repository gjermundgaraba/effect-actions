import {
  Cause,
  Clock,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Schema,
  Semaphore,
} from "effect";
import { ClusterSchema, DeliverAt } from "effect/cluster";
import { Rpc } from "effect/rpc";

import type * as Action from "../contract/Action.js";
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

/**
 * The entity's wake: `wakeAt` sends the persisted tell unless one this activation sent, due no
 * later, has not fired yet; `until` waits in the activation, asking again when an earlier wake
 * fires first; `woke` takes a delivery, which may be stale or replayed.
 */
export const makeWake = (
  send: (wake: WakeAt) => Effect.Effect<void, Action.Unavailable>
) =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const lock = yield* Semaphore.make(1);
    const pending = new Set<number>();
    const waiting = new Set<Deferred.Deferred<number>>();

    const wakeAt = (at: number) =>
      lock.withPermit(
        Effect.suspend(() =>
          [...pending].some((sent) => sent <= at)
            ? Effect.void
            : Effect.tap(send(new WakeAt({ at })), () =>
                Effect.sync(() => pending.add(at))
              )
        )
      );

    const slept = (at: number) =>
      clock.sleep(
        Duration.millis(Math.max(at - clock.currentTimeMillisUnsafe(), 0))
      );

    const until = (at: number): Effect.Effect<void> =>
      Effect.suspend(() => {
        const fired = Deferred.makeUnsafe<number>();

        waiting.add(fired);

        return wakeAt(at).pipe(
          Effect.matchCauseEffect({
            onFailure: (cause) => Effect.andThen(reported(cause), slept(at)),
            onSuccess: () =>
              Effect.flatMap(Deferred.await(fired), (woke) =>
                woke >= at ? Effect.void : until(at)
              ),
          }),
          Effect.ensuring(Effect.sync(() => waiting.delete(fired)))
        );
      });

    const woke = (at: number) =>
      Effect.sync(() => {
        for (const sent of pending) {
          if (sent <= at) {
            pending.delete(sent);
          }
        }

        const woken = [...waiting];

        waiting.clear();

        for (const fired of woken) {
          Deferred.doneUnsafe(fired, Exit.succeed(at));
        }
      });

    return {
      wake: Wake.of({
        wakeAt: (at) => wakeAt(DateTime.toEpochMillis(at)),
        until,
      }),
      woke,
    };
  });

/** Runs `effect`, reporting its failure or defect, an interruption left to end the wake. */
export const reportingFailures = <E, R>(effect: Effect.Effect<void, E, R>) =>
  Effect.catchCauseIf(
    effect,
    (cause) => !Cause.hasInterruptsOnly(cause),
    reported
  );
