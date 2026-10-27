import { describe, expect, it } from "@effect/vitest";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Clock, DateTime, Effect, Exit, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";

import {
  alarmOf,
  alarmPrefix,
  applicationOwner,
  makeSchedule,
} from "../../src/durable/alarm.js";

const hour = 60 * 60 * 1000;

let objects = 0;

const inObject = <A, E>(
  use: (
    schedule: ReturnType<typeof makeSchedule>,
    start: number,
    state: DurableObjectState
  ) => Effect.Effect<A, E>
) =>
  Effect.promise(async () => {
    objects += 1;

    return await runInDurableObject(
      env.ROUTER_PROVIDED.getByName(`schedule-${objects}`),
      async (_, state) => {
        const start = Date.now();

        return await Effect.runPromise(
          Effect.gen(function* () {
            yield* TestClock.setTime(start);

            const result = yield* Effect.exit(
              use(makeSchedule(state), start, state)
            );

            const alarm = yield* Effect.promise(
              async () => await state.storage.getAlarm()
            );

            return { result, alarm, start };
          }).pipe(Effect.provide(TestClock.layer()))
        );
      }
    );
  });

const recording = (ran: string[], name: string) => () =>
  Effect.sync(() => {
    ran.push(name);
  });

const Seconds = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 }));

const Step = Schema.Union([
  Schema.TaggedStruct("Set", { seconds: Seconds }),
  Schema.TaggedStruct("Clear", {}),
  Schema.TaggedStruct("Run", {
    sets: Schema.Array(Seconds).check(Schema.isBetweenLength(0, 3)),
    fails: Schema.Boolean,
  }),
]);

const documentedBackoff = [2000, 4000, 8000, 16_000, 32_000, 64_000];

const retryAfter = (attempt: number) => documentedBackoff[attempt - 1] ?? hour;

describe("the alarm schedule", () => {
  it.effect(
    "sets the runtime alarm for the earliest owner's time, and deletes it with none",
    () =>
      Effect.gen(function* () {
        const both = yield* inObject((schedule, start) =>
          Effect.andThen(
            schedule.set("later", start + 2 * hour),
            schedule.set("sooner", start + hour)
          )
        );

        const cleared = yield* inObject((schedule, start) =>
          Effect.all([
            schedule.set("later", start + 2 * hour),
            schedule.set("sooner", start + hour),
            schedule.clear("sooner"),
          ])
        );

        const none = yield* inObject((schedule, start) =>
          Effect.andThen(
            schedule.set("only", start + hour),
            schedule.clear("only")
          )
        );

        expect(both.alarm).toBe(both.start + hour);
        expect(cleared.alarm).toBe(cleared.start + 2 * hour);
        expect(none.alarm).toBeNull();
      })
  );

  it.effect(
    "runs each owner whose time has come, and sets the alarm for the next",
    () =>
      Effect.gen(function* () {
        const ran: string[] = [];

        const {
          result,
          alarm,
          start: startedAt,
        } = yield* inObject((schedule, start) =>
          Effect.gen(function* () {
            yield* schedule.set("first", start + hour);
            yield* schedule.set("second", start + 2 * hour);
            yield* schedule.set("third", start + 3 * hour);
            yield* TestClock.setTime(start + 2 * hour);
            yield* schedule.runDue({
              first: recording(ran, "first"),
              second: recording(ran, "second"),
              third: recording(ran, "third"),
            });
          })
        );

        expect(result).toStrictEqual(Exit.void);
        expect(ran).toStrictEqual(["first", "second"]);
        expect(alarm).toBe(startedAt + 3 * hour);
      })
  );

  it.effect(
    "runs no owner before its time at a repeated firing, and keeps the alarm for it",
    () =>
      Effect.gen(function* () {
        const ran: string[] = [];

        const { alarm, start: startedAt } = yield* inObject((schedule, start) =>
          Effect.gen(function* () {
            const owners = {
              sooner: recording(ran, "sooner"),
              later: recording(ran, "later"),
            };

            yield* schedule.set("sooner", start + hour);
            yield* schedule.set("later", start + 2 * hour);
            yield* TestClock.setTime(start + hour);
            yield* schedule.runDue(owners);
            yield* schedule.runDue(owners);
          })
        );

        expect(ran).toStrictEqual(["sooner"]);
        expect(alarm).toBe(startedAt + 2 * hour);
      })
  );

  it.effect(
    "retries a failed owner 2 seconds later, doubling, six times, then hourly, running the others",
    () =>
      Effect.gen(function* () {
        const retries: number[] = [];
        const ran: string[] = [];

        const { result, alarm } = yield* inObject((schedule, start, state) =>
          Effect.gen(function* () {
            const alarms: Array<number | null> = [];

            yield* schedule.set("failing", start + hour);
            yield* schedule.set("passing", start + hour);
            yield* TestClock.setTime(start + hour);

            for (let run = 0; run < 8; run += 1) {
              yield* schedule.runDue({
                failing: ({ retryCount }) =>
                  Effect.andThen(
                    Effect.sync(() => {
                      retries.push(retryCount);
                    }),
                    Effect.fail("unreachable")
                  ),
                passing: recording(ran, "passing"),
              });

              const now = yield* Clock.currentTimeMillis;

              const next = yield* Effect.promise(
                async () => await state.storage.getAlarm()
              );

              alarms.push(next === null ? null : next - now);

              if (next !== null) {
                yield* TestClock.setTime(next);
              }
            }

            return alarms;
          })
        );

        expect(result).toStrictEqual(
          Exit.succeed([2000, 4000, 8000, 16_000, 32_000, 64_000, hour, hour])
        );
        expect(retries).toStrictEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(ran).toStrictEqual(["passing"]);
        expect(alarm).not.toBeNull();
      })
  );

  it.effect(
    "runs an owner again whose run was cut off, at the alarm it set first, counted as a failure, and keeps the next time a run sets",
    () =>
      Effect.gen(function* () {
        const ran: string[] = [];
        const armed: Array<number | null> = [];

        const {
          result,
          alarm,
          start: startedAt,
        } = yield* inObject((schedule, start, state) =>
          Effect.gen(function* () {
            yield* schedule.set("digest", start + hour);
            yield* TestClock.setTime(start + hour);

            const cut = yield* Effect.forkChild(
              schedule.runDue({
                digest: ({ retryCount }) =>
                  Effect.promise(
                    async () => await state.storage.getAlarm()
                  ).pipe(
                    Effect.tap((at) =>
                      Effect.sync(() => {
                        armed.push(at);
                      })
                    ),
                    Effect.andThen(
                      recording(ran, `cut off at ${retryCount}`)()
                    ),
                    Effect.andThen(Effect.never)
                  ),
              })
            );

            yield* TestClock.adjust("0 millis");
            yield* Fiber.interrupt(cut);
            yield* TestClock.setTime(start + hour + 2000);

            yield* schedule.runDue({
              digest: ({ retryCount }) =>
                Effect.andThen(
                  recording(ran, `retried at ${retryCount}`)(),
                  schedule.set("digest", start + 25 * hour)
                ),
            });
          })
        );

        expect(result).toStrictEqual(Exit.void);
        expect(ran).toStrictEqual(["cut off at 0", "retried at 1"]);
        expect(armed).toStrictEqual([startedAt + hour + 2000]);
        expect(alarm).toBe(startedAt + 25 * hour);
      })
  );

  it.effect(
    "keeps a time an owner sets from its run, the one it ran for included",
    () =>
      Effect.gen(function* () {
        const {
          result,
          alarm,
          start: startedAt,
        } = yield* inObject((schedule, start) =>
          Effect.gen(function* () {
            yield* schedule.set("batch", start + hour);
            yield* TestClock.setTime(start + hour);
            yield* schedule.runDue({
              batch: ({ scheduledTime }) =>
                schedule.set("batch", scheduledTime),
            });
          })
        );

        expect(result).toStrictEqual(Exit.void);
        expect(alarm).toBe(startedAt + hour);
      })
  );

  it.effect(
    "runs a later owner from its time as its turn comes, cleared or postponed before",
    () =>
      Effect.gen(function* () {
        const ran: string[] = [];

        const {
          result,
          alarm,
          start: startedAt,
        } = yield* inObject((schedule, start, state) =>
          Effect.gen(function* () {
            yield* schedule.set("a", start + hour);
            yield* schedule.set("b", start + hour);
            yield* schedule.set("c", start + hour);
            yield* TestClock.setTime(start + hour);
            yield* schedule.runDue({
              a: () =>
                Effect.all([
                  Effect.sync(() => {
                    ran.push("a");
                  }),
                  schedule.clear("b"),
                  schedule.set("c", start + 5 * hour),
                ]),
              b: recording(ran, "b"),
              c: recording(ran, "c"),
            });

            return [
              ...(yield* Effect.promise(
                async () => await state.storage.list({ prefix: alarmPrefix })
              )).keys(),
            ];
          })
        );

        expect(result).toStrictEqual(Exit.succeed([`${alarmPrefix}c`]));
        expect(ran).toStrictEqual(["a"]);
        expect(alarm).toBe(startedAt + 5 * hour);
      })
  );

  it.effect(
    "cancels a failing owner's retry when cleared as it ran with no time set afterwards, and keeps the earlier of its retry and a time set as it ran, a clear before it included",
    () =>
      Effect.gen(function* () {
        const {
          result,
          alarm,
          start: startedAt,
        } = yield* inObject((schedule, start, state) =>
          Effect.gen(function* () {
            yield* schedule.set("cleared", start + hour);
            yield* schedule.set("later", start + hour);
            yield* schedule.set("postponed", start + hour);
            yield* schedule.set("sooner", start + hour);
            yield* TestClock.setTime(start + hour);
            yield* schedule.runDue({
              cleared: () =>
                Effect.andThen(
                  schedule.clear("cleared"),
                  Effect.fail("unreachable")
                ),
              later: () =>
                Effect.andThen(
                  schedule.set("later", start + 5 * hour),
                  Effect.fail("unreachable")
                ),
              postponed: () =>
                Effect.all([
                  schedule.clear("postponed"),
                  schedule.set("postponed", start + 5 * hour),
                  Effect.fail("unreachable"),
                ]),
              sooner: () =>
                Effect.andThen(
                  schedule.set("sooner", start + hour + 1000),
                  Effect.fail("unreachable")
                ),
            });

            return [
              ...(yield* Effect.promise(
                async () => await state.storage.list({ prefix: alarmPrefix })
              )),
            ];
          })
        );

        expect(result).toStrictEqual(
          Exit.succeed([
            [
              `${alarmPrefix}later`,
              { at: startedAt + hour + 2000, failures: 1 },
            ],
            [
              `${alarmPrefix}postponed`,
              { at: startedAt + hour + 2000, failures: 1 },
            ],
            [
              `${alarmPrefix}sooner`,
              { at: startedAt + hour + 1000, failures: 0 },
            ],
          ])
        );
        expect(alarm).toBe(startedAt + hour + 1000);
      })
  );

  it.effect(
    "reads the time 0.21.0 kept, marked running, for a run cut off as that run's retry",
    () =>
      Effect.gen(function* () {
        const { result } = yield* inObject((schedule, start, state) =>
          Effect.gen(function* () {
            const retries: number[] = [];

            yield* Effect.promise(async () => {
              await state.storage.put(`${alarmPrefix}cut`, {
                at: start + hour,
                failures: 1,
                running: true,
              });
            });
            yield* TestClock.setTime(start + hour);
            yield* schedule.runDue({
              cut: (info) =>
                Effect.sync(() => {
                  retries.push(info.retryCount);
                }),
            });

            return retries;
          })
        );

        expect(result).toStrictEqual(Exit.succeed([1]));
      })
  );

  it.effect(
    "times a failed owner's retry from its failure, however long it ran",
    () =>
      Effect.gen(function* () {
        const { result } = yield* inObject((schedule, start, state) =>
          Effect.gen(function* () {
            yield* schedule.set("slow", start + hour);
            yield* TestClock.setTime(start + hour);

            yield* schedule.runDue({
              slow: () =>
                Effect.andThen(
                  TestClock.adjust("5 seconds"),
                  Effect.fail("unreachable")
                ),
            });

            const now = yield* Clock.currentTimeMillis;

            const next = yield* Effect.promise(
              async () => await state.storage.getAlarm()
            );

            return next === null ? null : next - now;
          })
        );

        expect(result).toStrictEqual(Exit.succeed(2000));
      })
  );

  it.effect("drops the time of an owner the alarm does not run", () =>
    Effect.gen(function* () {
      const { result, alarm } = yield* inObject((schedule, start) =>
        Effect.all(
          [
            schedule.set("removed", start + hour),
            TestClock.setTime(start + hour),
            schedule.runDue<never, never>({}),
          ],
          { discard: true }
        )
      );

      expect(result).toStrictEqual(Exit.void);
      expect(alarm).toBeNull();
    })
  );

  it.live(
    "sets the alarm again as an instance builds, for the times kept with none set",
    () =>
      Effect.gen(function* () {
        const stub = env.ROUTER_PROVIDED.getByName("restored");

        const kept = yield* Effect.promise(
          async () =>
            await runInDurableObject(stub, async (_, state) => {
              const at = Date.now() + hour;

              await state.storage.put(`${alarmPrefix}application`, {
                at,
                failures: 0,
              });

              return at;
            })
        );

        yield* Effect.promise(async () => {
          await evictDurableObject(stub);
        });
        yield* Effect.promise(
          async () => await stub.fetch("https://object/unrouted")
        );

        const alarm = yield* Effect.promise(
          async () =>
            await runInDurableObject(
              stub,
              async (_, state) => await state.storage.getAlarm()
            )
        );

        expect(alarm).toBe(kept);
      })
  );

  it.live(
    "retries a failing alarm option at its backoff through the runtime's own alarm",
    () =>
      Effect.gen(function* () {
        const failing = env.FAILING.getByName("failing");

        yield* Effect.promise(async () => {
          await failing.arm();
        });
        yield* Effect.sleep("3 seconds");

        expect(yield* Effect.promise(async () => await failing.runs())).toBe(2);
      })
  );
});

describe("the application's alarm", () => {
  it.effect.prop(
    "runs the option no later than the earliest time set since it last ran or was cleared, or a failed run's retry if earlier",
    { steps: Schema.Array(Step).check(Schema.isBetweenLength(8, 24)) },
    ({ steps }) =>
      Effect.gen(function* () {
        const { result } = yield* inObject((schedule, start, state) =>
          Effect.gen(function* () {
            const alarm = alarmOf(schedule);

            const aheadOfTheRuntimesClock = start + hour;

            yield* TestClock.setTime(aheadOfTheRuntimesClock);

            const actual: Array<{ alarm: number | null; retryCount?: number }> =
              [];

            const expected: Array<{
              alarm: number | null;
              retryCount?: number;
            }> = [];

            let due: number | null = null;
            let failures = 0;

            for (const step of steps) {
              const now = yield* Clock.currentTimeMillis;

              if (step._tag === "Set") {
                const at = now + step.seconds * 1000;

                yield* alarm.set(DateTime.makeUnsafe(at));

                if (due === null || at < due) {
                  due = at;
                  failures = 0;
                }

                actual.push({
                  alarm: yield* Effect.promise(
                    async () => await state.storage.getAlarm()
                  ),
                });
                expected.push({ alarm: due });
              } else if (step._tag === "Clear") {
                yield* alarm.clear;
                due = null;
                failures = 0;
                actual.push({
                  alarm: yield* Effect.promise(
                    async () => await state.storage.getAlarm()
                  ),
                });
                expected.push({ alarm: due });
              } else if (due !== null) {
                const ranAt: number = due;
                let retryCount: number | undefined;

                yield* TestClock.setTime(ranAt);
                yield* schedule.runDue({
                  [applicationOwner]: (info) =>
                    Effect.andThen(
                      Effect.forEach(
                        step.sets,
                        (seconds) =>
                          alarm.set(
                            DateTime.makeUnsafe(ranAt + seconds * 1000)
                          ),
                        { discard: true }
                      ),
                      Effect.suspend(() => {
                        ({ retryCount } = info);

                        return step.fails
                          ? Effect.fail("unreachable")
                          : Effect.void;
                      })
                    ),
                });

                const ranWith = failures;

                const setAsItRan =
                  step.sets.length === 0
                    ? null
                    : ranAt + Math.min(...step.sets) * 1000;

                const retry = ranAt + retryAfter(failures + 1);

                if (step.fails && (setAsItRan === null || retry < setAsItRan)) {
                  due = retry;
                  failures += 1;
                } else {
                  due = setAsItRan;
                  failures = 0;
                }

                actual.push({
                  alarm: yield* Effect.promise(
                    async () => await state.storage.getAlarm()
                  ),
                  ...(retryCount === undefined ? {} : { retryCount }),
                });
                expected.push({ alarm: due, retryCount: ranWith });
              }
            }

            return { actual, expected };
          })
        );

        const { actual, expected } = yield* result;

        expect(actual).toStrictEqual(expected);
      }),
    { timeout: 30_000, arbitrary: { runs: 100 } }
  );

  it.effect(
    "keeps a failed run's retry before a later time, and an earlier time in its place, which runs as no retry",
    () =>
      Effect.gen(function* () {
        const { result, start: startedAt } = yield* inObject(
          (schedule, start, state) =>
            Effect.gen(function* () {
              const alarm = alarmOf(schedule);

              const runtimeAlarm = Effect.promise(
                async () => await state.storage.getAlarm()
              );

              yield* alarm.set(DateTime.makeUnsafe(start + hour));
              yield* TestClock.setTime(start + hour);
              yield* schedule.runDue({
                [applicationOwner]: () => Effect.fail("unreachable"),
              });

              const retry = yield* runtimeAlarm;

              yield* alarm.set(DateTime.makeUnsafe(start + 2 * hour));

              const later = yield* runtimeAlarm;

              yield* alarm.set(DateTime.makeUnsafe(start + hour + 1000));

              const earlier = yield* runtimeAlarm;
              const retryCounts: number[] = [];

              yield* TestClock.setTime(start + hour + 1000);
              yield* schedule.runDue({
                [applicationOwner]: ({ retryCount }) =>
                  Effect.sync(() => {
                    retryCounts.push(retryCount);
                  }),
              });

              return [retry, later, earlier, retryCounts];
            })
        );

        expect(result).toStrictEqual(
          Exit.succeed([
            startedAt + hour + 2000,
            startedAt + hour + 2000,
            startedAt + hour + 1000,
            [0],
          ])
        );
      })
  );

  it.effect(
    "keeps the retry of a run cut off before a later time set by the next instance, and an earlier time in its place",
    () =>
      Effect.gen(function* () {
        const { result, start: startedAt } = yield* inObject(
          (schedule, start, state) =>
            Effect.gen(function* () {
              const runtimeAlarm = Effect.promise(
                async () => await state.storage.getAlarm()
              );

              yield* alarmOf(schedule).set(DateTime.makeUnsafe(start + hour));
              yield* TestClock.setTime(start + hour);

              const cut = yield* Effect.forkChild(
                schedule.runDue({ [applicationOwner]: () => Effect.never })
              );

              yield* TestClock.adjust("0 millis");
              yield* Fiber.interrupt(cut);

              const next = alarmOf(makeSchedule(state));

              yield* next.set(DateTime.makeUnsafe(start + 2 * hour));

              const later = yield* runtimeAlarm;

              yield* next.set(DateTime.makeUnsafe(start + hour + 1000));

              return [later, yield* runtimeAlarm];
            })
        );

        expect(result).toStrictEqual(
          Exit.succeed([startedAt + hour + 2000, startedAt + hour + 1000])
        );
      })
  );
});
