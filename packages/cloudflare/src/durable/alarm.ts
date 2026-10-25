import { Clock, Context, DateTime, Effect, Exit, Layer, Option, Schema, Semaphore } from "effect";
import { State } from "./state.js";

/** Where the object's alarm times are kept, one key per owner. */
export const alarmPrefix = "effect-actions/alarm/";

// Why: `running` marks the time of a run under way, so a time its owner sets from the run, the
// same one included, replaces the mark and is kept once the run ends. `failures` counts the
// run under way, so a run cut off is retried as a failed one.
const Kept = Schema.Struct({
  at: Schema.Finite,
  failures: Schema.Int,
  running: Schema.optional(Schema.Boolean),
});

const keptOf = Schema.decodeUnknownOption(Kept);

// Why: a failed owner is retried as the runtime retries a plain object's failed alarm, 2 seconds
// later, doubling, six times. The runtime cannot do it for one owner among several, and a
// handler that re-arms the alarm as it fails replaces the runtime's retry with its own time.
// Past those six, the runtime drops a plain object's alarm; an owner's time is kept instead,
// retried hourly, as the work it stands for is lost with it.
const backoffRetries = 6;

const hour = 60 * 60 * 1000;

const retryDelay = (failures: number) =>
  failures > backoffRetries ? hour : 2000 * 2 ** (failures - 1);

/**
 * What runs at the object's one alarm, by owner, given its retry count: the application's
 * `alarm` option, when its time has come.
 */
type Owners<R> = Readonly<
  Record<string, (info: AlarmInvocationInfo) => Effect.Effect<void, unknown, R>>
>;

/**
 * The object's alarm times, one per owner, kept in its storage: the runtime's one alarm is set
 * for the earliest, and `runDue` runs each owner whose time has come.
 */
// Why: a set and a run's end each read an owner's time and then write it, so they take turns, per
// object, however many schedules are made for it: the end of a run never deletes a time set as it
// ended.
const locks = new WeakMap<DurableObjectState, Semaphore.Semaphore>();

const lockOf = (state: DurableObjectState) => {
  const found = locks.get(state) ?? Semaphore.makeUnsafe(1);

  locks.set(state, found);

  return found;
};

export const makeSchedule = (state: DurableObjectState) => {
  const storage = state.storage;
  const lock = lockOf(state);

  const times = Effect.promise(() => storage.list({ prefix: alarmPrefix })).pipe(
    Effect.map((listed) =>
      [...listed].flatMap(([key, value]) =>
        Option.match(keptOf(value), {
          onNone: () => [],
          onSome: (kept) => [{ owner: key.slice(alarmPrefix.length), ...kept }],
        }),
      ),
    ),
  );

  // Why: the runtime keeps one alarm per object, so it is set for the earliest owner's time,
  // and deleted once none is left, every time an owner's changes.
  const rearm = Effect.flatMap(times, (kept) => {
    const earliest = Math.min(...kept.map(({ at }) => at));

    return Effect.promise(() =>
      Number.isFinite(earliest) ? storage.setAlarm(earliest) : storage.deleteAlarm(),
    );
  });

  const keep = (owner: string, kept: typeof Kept.Type) =>
    Effect.promise(() => storage.put(`${alarmPrefix}${owner}`, kept));

  return {
    rearm,
    // Why: the runtime gives up on an alarm whose handler crashes, past its own retries, which
    // leaves the times kept with no alarm to run them: an instance's build sets it again.
    restore: lock.withPermits(1)(
      Effect.flatMap(
        Effect.promise(() => storage.getAlarm()),
        (alarm) =>
          alarm === null
            ? Effect.flatMap(times, (kept) => (kept.length === 0 ? Effect.void : rearm))
            : Effect.void,
      ),
    ),
    // Why: a store setting the same time on every write, as chat-rooms' does on each post,
    // costs one read, not a write, a list and the alarm's.
    set: (owner: string, at: number) =>
      lock.withPermits(1)(
        Effect.flatMap(
          Effect.promise(() => storage.get(`${alarmPrefix}${owner}`)),
          (stored) =>
            Option.exists(
              keptOf(stored),
              (kept) => kept.at === at && kept.failures === 0 && kept.running !== true,
            )
              ? Effect.void
              : Effect.andThen(keep(owner, { at, failures: 0 }), rearm),
        ),
      ),
    clear: (owner: string) =>
      lock.withPermits(1)(
        Effect.andThen(
          Effect.promise(() => storage.delete(`${alarmPrefix}${owner}`)),
          rearm,
        ),
      ),
    /**
     * Runs each owner whose time has come as its turn comes, removing its time once its run ends
     * unless one was set or cleared as it ran: one that fails is logged and retried, 2 seconds
     * later, doubling, six times, then hourly.
     */
    runDue: <R>(owners: Owners<R>) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const kept = yield* times;

        // Why: the runtime alarm is set for the earliest time, so its firing makes that time due
        // even before it comes, as `runDurableObjectAlarm` fires it in a test.
        const dueBy = Math.max(now, Math.min(...kept.map(({ at }) => at)));

        yield* Effect.forEach(
          kept.filter(({ at }) => at <= dueBy),
          ({ owner }) =>
            Effect.gen(function* () {
              const key = `${alarmPrefix}${owner}`;
              const run = owners[owner];

              const stored = Effect.map(
                Effect.promise(() => storage.get(key)),
                (value) => Option.getOrUndefined(keptOf(value)),
              );

              const drop = Effect.promise(() => storage.delete(key));

              // Why: an earlier owner's run lets a request in, which may clear or postpone this
              // owner's time, so its turn reads the time storage holds now, not the one listed.
              // A run an eviction, a deploy or a crash cuts off is retried, so its time stays
              // kept, marked running and counted as failed, until its run ends, at its retry's
              // time, the alarm set for it and the write made durable before the run: one deleted
              // first would leave the retry nothing to run, and a retry the runtime gives up on
              // would leave it no alarm.
              const due = yield* lock.withPermits(1)(
                Effect.gen(function* () {
                  const current = yield* stored;

                  if (current === undefined || current.at > dueBy) return undefined;

                  if (run === undefined) return yield* Effect.as(drop, undefined);

                  const startedAt = yield* Clock.currentTimeMillis;

                  yield* keep(owner, {
                    at: startedAt + retryDelay(current.failures + 1),
                    failures: current.failures + 1,
                    running: true,
                  }).pipe(
                    Effect.andThen(rearm),
                    Effect.andThen(Effect.promise(() => storage.sync())),
                  );

                  return { ...current, run };
                }),
              );

              if (due === undefined) return;

              const { at, failures } = due;
              const attempt = failures + 1;

              const exit = yield* Effect.exit(
                due.run({ retryCount: failures, isRetry: failures > 0, scheduledTime: at }),
              );

              if (Exit.isFailure(exit)) {
                yield* Effect.logError(
                  `The alarm of ${owner} failed: retried in ${retryDelay(attempt)} ms`,
                  exit.cause,
                );
              }

              // Why: the retry is timed from the failure, so an owner that runs long before it fails
              // still waits its whole backoff, not what is left of it after its run.
              const endedAt = yield* Clock.currentTimeMillis;

              // Why: a run's end changes its owner's time only while it is still the run's mark,
              // so a time set or cleared as it ran wins, whether the run succeeded or failed.
              yield* lock.withPermits(1)(
                Effect.flatMap(stored, (current) =>
                  current?.running !== true
                    ? Effect.void
                    : Exit.isSuccess(exit)
                      ? drop
                      : keep(owner, { at: endedAt + retryDelay(attempt), failures: attempt }),
                ),
              );
            }),
          { discard: true },
        );

        // Why: a rearm lists the times, then sets the alarm for the earliest, so a set between
        // the two, outside the lock, would be overwritten with the times listed before it.
        yield* lock.withPermits(1)(rearm);
      }),
  };
};

/** The owner the application's `alarm` option runs as. */
export const applicationOwner = "application";

/**
 * When the object's `alarm` option runs: `set(at)` schedules it, replacing an earlier time, and
 * `clear` cancels it. A startup service of the object's services, routes, calls and `run`, as
 * `State` is. The object's one runtime alarm is the package's, set for the earliest of the
 * times it keeps, so an application never sets it itself.
 *
 * **Gotchas**
 *
 * - `State`'s `storage.setAlarm` replaces the package's alarm: the times it keeps then run at that alarm, early or late, or never, and the `alarm` option runs only for a time `Alarm.set` gave, so schedule with `Alarm`.
 * - The object's alarm firing runs the earliest time even before it comes, as `runDurableObjectAlarm` fires it in a test.
 * - A time already past runs at once; the option runs once per `set`, and sets its next itself.
 * - The times live in the object's storage, under `effect-actions/alarm/`, beside the application's data: a store deleting every key deletes them too.
 */
export class Alarm extends Context.Service<
  Alarm,
  {
    /** Runs the object's `alarm` option at `at`, in place of any time set before. */
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
   */
  static readonly layer: Layer.Layer<Alarm, never, State> = Layer.effect(Alarm)(
    Effect.map(State, (state) => {
      const schedule = makeSchedule(state);

      return Alarm.of({
        set: (at) => schedule.set(applicationOwner, DateTime.toEpochMillis(at)),
        clear: schedule.clear(applicationOwner),
      });
    }),
  );
}
