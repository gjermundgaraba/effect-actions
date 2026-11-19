import {
  Clock,
  DateTime,
  Deferred,
  Duration,
  Effect,
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
 * The entity's wake. `wakeAt` sends the persisted tell unless one this activation stored, due no
 * later, has not fired; `until` stores its own deadline, unless one at that time is pending, then
 * waits for a wake due no earlier, so no earlier wake hands it over; `woke` takes a delivery,
 * which may be stale or replayed. A send and its record hold the lock, uninterruptibly, and so
 * does a delivery's bookkeeping, so a delivery racing its own send cannot leave a fired time pending.
 */
export const makeWake = (
  send: (wake: WakeAt) => Effect.Effect<void, Action.Unavailable>
) =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const lock = yield* Semaphore.make(1);
    const pending = new Set<number>();
    let latest = -Infinity;
    let fired = Deferred.makeUnsafe<undefined>();

    const stored = (at: number, covers: (sent: number) => boolean) =>
      lock.withPermit(
        Effect.suspend(() =>
          [...pending].some(covers)
            ? Effect.void
            : Effect.uninterruptible(
                Effect.tap(send(new WakeAt({ at })), () =>
                  Effect.sync(() => pending.add(at))
                )
              )
        )
      );

    const slept = (at: number) =>
      clock.sleep(
        Duration.millis(Math.max(at - clock.currentTimeMillisUnsafe(), 0))
      );

    const due = (at: number): Effect.Effect<void> =>
      Effect.suspend(() =>
        latest >= at
          ? Effect.void
          : Effect.andThen(Deferred.await(fired), due(at))
      );

    const until = (at: number) =>
      stored(at, (sent) => sent === at).pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) => Effect.andThen(reported(cause), slept(at)),
          onSuccess: () => due(at),
        })
      );

    const woke = (at: number) =>
      lock
        .withPermit(
          Effect.sync(() => {
            for (const sent of pending) {
              if (sent <= at) {
                pending.delete(sent);
              }
            }

            latest = Math.max(latest, at);

            const done = fired;

            fired = Deferred.makeUnsafe();

            return done;
          })
        )
        .pipe(Effect.flatMap((done) => Deferred.succeed(done, undefined)));

    return {
      wake: Wake.of({
        wakeAt: (at) => stored(at, (sent) => sent <= at),
        until,
      }),
      woke,
    };
  });
