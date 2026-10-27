import {
  Clock,
  Context,
  DateTime,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
  Semaphore,
} from "effect";

import { State } from "./state.js";

/** Where the object's alarm times are kept, one key per owner. */
export const alarmPrefix = "effect-actions/alarm/";

const keyOf = (owner: string) => `${alarmPrefix}${owner}`;

// Why: a time set is kept with `failures` 0. A run under way keeps its retry's time, counting
// itself as failed, so a run cut off is retried as a failed one: a time kept with `failures`
// above 0 is that mark, or a retry due.
const Kept = Schema.Struct({ at: Schema.Finite, failures: Schema.Int });

const keptOf = Schema.decodeUnknownOption(Kept);

// Why: a failed owner is retried as the runtime retries a plain object's failed alarm, 2 seconds
// later, doubling, six times. The runtime cannot do it for one owner among several, and a
// handler that re-arms the alarm as it fails replaces the runtime's retry with its own time.
// Past those six, the runtime drops a plain object's alarm; an owner's time is kept instead,
// retried hourly, as the work it stands for, a webhook's delivery among them, is lost with it.
const backoffRetries = 6;

const hour = 60 * 60 * 1000;

const retryDelay = (failures: number) =>
  failures > backoffRetries ? hour : 2000 * 2 ** (failures - 1);

/**
 * What runs at the object's one alarm, by owner, given its retry count: the application's
 * `alarm` option, and the package's own work, each when its time has come.
 */
type Owners<E, R> = Readonly<
  Record<string, (info: AlarmInvocationInfo) => Effect.Effect<void, E, R>>
>;

/**
 * The object's alarm times, one per owner, kept in its storage: the runtime's one alarm is set
 * for the earliest, and `runDue` runs each owner whose time has come. `handlers` and `make` make
 * one per instance, which its `Alarm` and its `alarm` handler share.
 */
export const makeSchedule = (state: DurableObjectState) => {
  const { storage } = state;
  // Why: a set and a run's end each read an owner's time and then write it, so they take turns:
  // the end of a run never deletes a time set as it ended.
  const lock = Semaphore.makeUnsafe(1);
  // Why: an owner is running only while this instance runs it, never in storage, so the mark of
  // a run an eviction, a deploy or a crash cut off reads as the retry it is.
  const running = new Set<string>();

  const read = (owner: string) =>
    Effect.map(
      Effect.promise(async () => await storage.get(keyOf(owner))),
      keptOf
    );

  const times = Effect.promise(
    async () => await storage.list({ prefix: alarmPrefix })
  ).pipe(
    Effect.map((listed) =>
      [...listed].flatMap(([key, value]) =>
        Option.match(keptOf(value), {
          onNone: () => [],
          onSome: (kept) => [{ owner: key.slice(alarmPrefix.length), ...kept }],
        })
      )
    )
  );

  // Why: the runtime keeps one alarm per object, so it is set for the earliest owner's time,
  // and deleted once none is left, every time an owner's changes.
  const rearm = Effect.flatMap(times, (kept) => {
    const earliest = Math.min(...kept.map(({ at }) => at));

    return Effect.promise(async () => {
      await (Number.isFinite(earliest)
        ? storage.setAlarm(earliest)
        : storage.deleteAlarm());
    });
  });

  const keep = (owner: string, kept: typeof Kept.Type) =>
    Effect.promise(async () => {
      await storage.put(keyOf(owner), kept);
    });

  return {
    rearm,
    // Why: the runtime gives up on an alarm whose handler crashes, past its own retries, which
    // leaves the times kept with no alarm to run them: an instance's build sets it again.
    restore: lock.withPermits(1)(
      Effect.flatMap(
        Effect.promise(async () => await storage.getAlarm()),
        (alarm) =>
          alarm === null
            ? Effect.flatMap(times, (kept) =>
                kept.length === 0 ? Effect.void : rearm
              )
            : Effect.void
      )
    ),
    // Why: an owner setting its time again unchanged, as `layerWebhooks` does its earliest wait
    // whenever its waits change, costs one read, not a write, a list and the alarm's.
    /**
     * Keeps `at` as the owner's time, in place of any: set as the owner's run fails, it gives way
     * to that run's retry where the retry is earlier.
     */
    set: (owner: string, at: number) =>
      lock.withPermits(1)(
        Effect.flatMap(read(owner), (kept) =>
          Option.exists(kept, (held) => held.at === at && held.failures === 0)
            ? Effect.void
            : Effect.andThen(keep(owner, { at, failures: 0 }), rearm)
        )
      ),
    // Why: a store setting a time on every write, as chat-rooms' does on each post, costs one
    // read, not a write, a list and the alarm's, while an earlier time is kept.
    /**
     * Keeps `at` as the owner's time unless an earlier one is kept, a retry due included: the
     * mark of the owner's run under way is no time, so a time set from the run is kept.
     */
    setBy: (owner: string, at: number) =>
      lock.withPermits(1)(
        Effect.flatMap(read(owner), (kept) =>
          Option.exists(
            kept,
            (held) =>
              held.at <= at && (held.failures === 0 || !running.has(owner))
          )
            ? Effect.void
            : Effect.andThen(keep(owner, { at, failures: 0 }), rearm)
        )
      ),
    clear: (owner: string) =>
      lock.withPermits(1)(
        Effect.andThen(
          Effect.promise(async () => await storage.delete(keyOf(owner))),
          rearm
        )
      ),
    /**
     * Runs each owner whose time has come as its turn comes, removing its time once its run
     * succeeds unless one was set or cleared as it ran: one that fails is logged and retried, 2
     * seconds later, doubling, six times, then hourly, unless cleared as it ran or a time set as
     * it ran is earlier.
     */
    runDue: <E, R>(owners: Owners<E, R>) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const kept = yield* times;

        yield* Effect.forEach(
          kept.filter(({ at }) => at <= now),
          ({ owner }) =>
            Effect.gen(function* () {
              const run = owners[owner];

              const stored = Effect.map(read(owner), Option.getOrUndefined);

              const drop = Effect.promise(
                async () => await storage.delete(keyOf(owner))
              );

              // Why: an earlier owner's run lets a request in, which may clear or postpone this
              // owner's time, so its turn reads the time storage holds now, not the one listed.
              // A run an eviction, a deploy or a crash cuts off is retried, so its time stays
              // kept, as its mark counted as failed, until its run ends, at its retry's time, the
              // alarm set for it and the write made durable before the run: one deleted first
              // would leave the retry nothing to run, and a retry the runtime gives up on would
              // leave it no alarm.
              const due = yield* lock.withPermits(1)(
                Effect.gen(function* () {
                  const current = yield* stored;

                  if (current === undefined || current.at > now) {
                    return;
                  }

                  if (run === undefined) {
                    return yield* Effect.as(drop, undefined);
                  }

                  const startedAt = yield* Clock.currentTimeMillis;

                  const mark = {
                    at: startedAt + retryDelay(current.failures + 1),
                    failures: current.failures + 1,
                  };

                  yield* keep(owner, mark).pipe(
                    Effect.andThen(rearm),
                    Effect.andThen(
                      Effect.promise(async () => {
                        await storage.sync();
                      })
                    )
                  );

                  running.add(owner);

                  return { ...current, mark, run };
                })
              );

              if (due === undefined) {
                return;
              }

              const { at, failures, mark } = due;
              const attempt = failures + 1;

              const exit = yield* Effect.exit(
                due.run({
                  retryCount: failures,
                  isRetry: failures > 0,
                  scheduledTime: at,
                })
              );

              if (Exit.isFailure(exit)) {
                yield* Effect.logError(
                  `The alarm of ${owner} failed: retried in ${retryDelay(attempt)} ms`,
                  exit.cause
                );
              }

              // Why: the retry is timed from the failure, so an owner that runs long before it fails
              // still waits its whole backoff, not what is left of it after its run.
              const endedAt = yield* Clock.currentTimeMillis;

              // Why: a succeeded run drops its owner's time only while it is still the run's mark,
              // so a time set as it ran is kept: a time set is kept with `failures` 0, never the
              // mark's count. A failed run's retry gives way only to a clear as it ran, or to an
              // earlier time set as it ran, as `Options.alarm` retries every failure: when any
              // time set as it ran replaced the retry, a request's later time dropped it. The
              // owner stops running under the lock, so a set waiting on it reads what this end
              // keeps.
              yield* lock.withPermits(1)(
                Effect.gen(function* () {
                  running.delete(owner);

                  const current = yield* stored;

                  const isMark =
                    current?.at === mark.at &&
                    current.failures === mark.failures;

                  if (Exit.isSuccess(exit)) {
                    if (isMark) {
                      yield* drop;
                    }

                    return;
                  }

                  if (current === undefined) {
                    return;
                  }

                  const retry = {
                    at: endedAt + retryDelay(attempt),
                    failures: attempt,
                  };

                  if (isMark || retry.at < current.at) {
                    yield* keep(owner, retry);
                  }
                })
              );
            }).pipe(
              // Why: a run interrupted before its end leaves the owner running no longer, so the
              // mark it kept reads as the retry it is.
              Effect.ensuring(
                Effect.sync(() => {
                  running.delete(owner);
                })
              )
            ),
          { discard: true }
        );

        // Why: a rearm lists the times, then sets the alarm for the earliest, so a set between
        // the two, outside the lock, would be overwritten with the times listed before it.
        yield* lock.withPermits(1)(rearm);
      }),
  };
};

export type Schedule = ReturnType<typeof makeSchedule>;

/** The owner the application's `alarm` option runs as. */
export const applicationOwner = "application";

/** The application's alarm over `schedule`, the instance's. */
export const alarmOf = (schedule: Schedule) =>
  Alarm.of({
    set: (at) => schedule.setBy(applicationOwner, DateTime.toEpochMillis(at)),
    clear: schedule.clear(applicationOwner),
  });

/**
 * When the object's `alarm` option runs: `set(at)` has it run no later than `at`, and `clear`
 * cancels it. A startup service of the object's services, routes, calls and `run`, as `State`
 * is. The object's one runtime alarm is the package's, set for the earliest of the times it
 * keeps, the package's own work among them, so an application never sets it itself.
 *
 * **Gotchas**
 *
 * - `State`'s `storage.setAlarm` replaces the package's alarm: the times it keeps then run at that alarm, early or late, or never, and the `alarm` option runs only for a time `Alarm.set` gave, so schedule with `Alarm`.
 * - A firing before every time it keeps, as a repeated one or `runDurableObjectAlarm` in a test, runs none and sets the alarm again: a test runs a time once it has come.
 * - A time already past runs at once; the option runs once for every time set before its run, and sets its next itself.
 * - The times live in the object's storage, under `effect-actions/alarm/`, beside the application's data: a store deleting every key deletes them too.
 */
export class Alarm extends Context.Service<
  Alarm,
  {
    /**
     * Runs the object's `alarm` option no later than `at`: the earliest time set since it last
     * ran, or a failed run's retry if earlier, so each deadline sets its own. A failed run's
     * retry stays unless it was cleared as it ran with no time set afterwards, or a time set as
     * it ran is earlier.
     *
     * **Gotchas**
     *
     * - A later time leaves an earlier one in place, so the option runs early: postpone with `clear`, then `set`.
     */
    readonly set: (at: DateTime.DateTime) => Effect.Effect<void>;
    /** Cancels the time set, if any. */
    readonly clear: Effect.Effect<void>;
  }
>()("effect-actions-cloudflare/ActionDurableObject/Alarm") {
  /**
   * The application's alarm, over the schedule of the instance whose `State` it is given.
   *
   * **Gotchas**
   *
   * - Only `handlers`' and `make`'s `alarm` runs the times it keeps: provide this layer alone only where nothing calls `set`, as to a store under test.
   * - Each build makes a schedule of its own, which takes no turns with the object's: a `set` through it while the object's alarm runs may be lost, so an object's own code uses the `Alarm` `handlers` and `make` provide.
   */
  static readonly layer: Layer.Layer<Alarm, never, State> = Layer.effect(Alarm)(
    Effect.map(State, (state) => alarmOf(makeSchedule(state)))
  );
}
