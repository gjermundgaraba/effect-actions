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

export const alarmPrefix = "effect-actions/alarm/";

const keyOf = (owner: string) => `${alarmPrefix}${owner}`;

const Kept = Schema.Struct({ at: Schema.Finite, failures: Schema.Int });

const keptOf = Schema.decodeUnknownOption(Kept);

const backoffRetries = 6;

const hour = 60 * 60 * 1000;

const retryDelay = (failures: number) =>
  failures > backoffRetries ? hour : 2000 * 2 ** (failures - 1);

type Owners<E, R> = Readonly<
  Record<string, (info: AlarmInvocationInfo) => Effect.Effect<void, E, R>>
>;

export const makeSchedule = (state: DurableObjectState) => {
  const { storage } = state;
  const lock = Semaphore.makeUnsafe(1);
  const runningInThisInstance = new Set<string>();

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
    set: (owner: string, at: number) =>
      lock.withPermits(1)(
        Effect.flatMap(read(owner), (kept) =>
          Option.exists(kept, (held) => held.at === at && held.failures === 0)
            ? Effect.void
            : Effect.andThen(keep(owner, { at, failures: 0 }), rearm)
        )
      ),
    setBy: (owner: string, at: number) =>
      lock.withPermits(1)(
        Effect.flatMap(read(owner), (kept) =>
          Option.exists(
            kept,
            (held) =>
              held.at <= at &&
              (held.failures === 0 || !runningInThisInstance.has(owner))
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

                  runningInThisInstance.add(owner);

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

              const endedAt = yield* Clock.currentTimeMillis;

              yield* lock.withPermits(1)(
                Effect.gen(function* () {
                  runningInThisInstance.delete(owner);

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
              Effect.ensuring(
                Effect.sync(() => {
                  runningInThisInstance.delete(owner);
                })
              )
            ),
          { discard: true }
        );

        yield* lock.withPermits(1)(rearm);
      }),
  };
};

export type Schedule = ReturnType<typeof makeSchedule>;

export const applicationOwner = "application";

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
