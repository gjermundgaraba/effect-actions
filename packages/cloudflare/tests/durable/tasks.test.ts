import { describe, expect, it } from "@effect/vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { alarmPrefix, makeSchedule } from "../../src/durable/alarm.js";
import { makeTasks, taskOwner } from "../../src/durable/tasks.js";
import { runAlarmDue } from "../support/alarm.js";

let objects = 0;

const mark = `${alarmPrefix}${taskOwner("tell")}`;

const pastTheRuntimesAlarm = 60 * 60 * 1000;

const marksIn = (state: DurableObjectState) =>
  Effect.promise(async () => {
    const marks = await state.storage.list({ prefix: alarmPrefix });

    return [...marks.keys()];
  });

const inObject = <A, E>(
  use: (state: DurableObjectState, start: number) => Effect.Effect<A, E>
) =>
  Effect.promise(async () => {
    objects += 1;

    return await runInDurableObject(
      env.ROUTER_PROVIDED.getByName(`tasks-${objects}`),
      async (_, state) => {
        const start = Date.now() + pastTheRuntimesAlarm;

        return await Effect.runPromise(
          Effect.gen(function* () {
            yield* TestClock.setTime(start);

            const result = yield* Effect.exit(use(state, start));
            const marks = yield* marksIn(state);

            return { result, marks };
          }).pipe(Effect.provide(TestClock.layer()))
        );
      }
    );
  });

const tellingOver = <E>(
  state: DurableObjectState,
  tell: Effect.Effect<void, E>
) => {
  const schedule = makeSchedule(state);
  const { tasks, owners } = makeTasks(schedule, { tell });

  return { tasks, alarm: schedule.runDue(owners) };
};

describe("an object's tasks", () => {
  it.effect(
    "marks a task due now, and runs it on the alarm after its change, leaving no mark once it succeeds",
    () =>
      Effect.gen(function* () {
        const ran: string[] = [];

        const { result, marks } = yield* inObject((state, start) =>
          Effect.gen(function* () {
            const { tasks, alarm } = tellingOver(
              state,
              Effect.sync(() => {
                ran.push("told");
              })
            );

            const changed = yield* tasks.runAfter(
              "tell",
              Effect.sync(() => ran.push("changed"))
            );

            const due = yield* Effect.promise(
              async () => await state.storage.get<{ at: number }>(mark)
            );

            const beforeTheAlarm = [...ran];

            yield* alarm;

            return {
              changed,
              dueIn: due === undefined ? null : due.at - start,
              beforeTheAlarm,
            };
          })
        );

        expect(result).toStrictEqual(
          Exit.succeed({ changed: 1, dueIn: 0, beforeTheAlarm: ["changed"] })
        );
        expect(ran).toStrictEqual(["changed", "told"]);
        expect(marks).toStrictEqual([]);
      })
  );

  it.effect(
    "runs a task after a change that failed, which fails as the change did",
    () =>
      Effect.gen(function* () {
        const ran: string[] = [];

        const { result, marks } = yield* inObject((state) =>
          Effect.gen(function* () {
            const { tasks, alarm } = tellingOver(
              state,
              Effect.sync(() => {
                ran.push("told");
              })
            );

            const refused = yield* Effect.exit(
              tasks.runAfter("tell", Effect.fail("no"))
            );

            yield* alarm;

            return refused;
          })
        );

        expect(result).toStrictEqual(Exit.succeed(Exit.fail("no")));
        expect(ran).toStrictEqual(["told"]);
        expect(marks).toStrictEqual([]);
      })
  );

  it.effect(
    "keeps a task that failed marked, and the alarm retries it until it succeeds",
    () =>
      Effect.gen(function* () {
        let attempts = 0;

        const { result, marks } = yield* inObject((state) =>
          Effect.gen(function* () {
            const { tasks, alarm } = tellingOver(
              state,
              Effect.suspend(() => {
                attempts += 1;

                return attempts < 3 ? Effect.fail("unreachable") : Effect.void;
              })
            );

            yield* tasks.runAfter("tell", Effect.void);

            for (
              let at = yield* Effect.promise(
                async () => await state.storage.getAlarm()
              );
              at !== null;
              at = yield* Effect.promise(
                async () => await state.storage.getAlarm()
              )
            ) {
              yield* TestClock.setTime(at);
              yield* alarm;
            }
          })
        );

        expect(result).toStrictEqual(Exit.void);
        expect(attempts).toBe(3);
        expect(marks).toStrictEqual([]);
      })
  );

  it.effect(
    "marks a task before its change, so a crash during the change leaves it marked",
    () =>
      Effect.gen(function* () {
        const { result } = yield* inObject((state) =>
          Effect.gen(function* () {
            const changing = yield* Deferred.make<undefined>();
            const { tasks } = tellingOver(state, Effect.void);

            const change = yield* Effect.forkChild(
              tasks.runAfter(
                "tell",
                Effect.andThen(
                  Deferred.succeed(changing, undefined),
                  Effect.never
                )
              )
            );

            yield* Deferred.await(changing);

            const during = yield* marksIn(state);

            yield* Fiber.interrupt(change);

            return during;
          })
        );

        expect(result).toStrictEqual(Exit.succeed([mark]));
      })
  );

  it.effect(
    "runs a task once for the changes made before the alarm runs it",
    () =>
      Effect.gen(function* () {
        let told = 0;

        const { result, marks } = yield* inObject((state) =>
          Effect.gen(function* () {
            const { tasks, alarm } = tellingOver(
              state,
              Effect.sync(() => {
                told += 1;
              })
            );

            yield* tasks.runAfter("tell", Effect.void);
            yield* tasks.runAfter("tell", Effect.void);
            yield* alarm;
          })
        );

        expect(result).toStrictEqual(Exit.void);
        expect(told).toBe(1);
        expect(marks).toStrictEqual([]);
      })
  );

  it.effect(
    "runs a task again for a change that ended after the alarm ran it",
    () =>
      Effect.gen(function* () {
        let told = 0;

        const { result, marks } = yield* inObject((state) =>
          Effect.gen(function* () {
            const changing = yield* Deferred.make<undefined>();
            const ended = yield* Deferred.make<undefined>();

            const { tasks, alarm } = tellingOver(
              state,
              Effect.sync(() => {
                told += 1;
              })
            );

            const change = yield* Effect.forkChild(
              tasks.runAfter(
                "tell",
                Effect.andThen(
                  Deferred.succeed(changing, undefined),
                  Deferred.await(ended)
                )
              )
            );

            yield* Deferred.await(changing);
            yield* alarm;

            const afterTheFirstRun = yield* marksIn(state);

            yield* Deferred.succeed(ended, undefined);
            yield* Fiber.join(change);

            const afterTheChange = yield* marksIn(state);

            yield* alarm;

            return { afterTheFirstRun, afterTheChange };
          })
        );

        expect(result).toStrictEqual(
          Exit.succeed({ afterTheFirstRun: [], afterTheChange: [mark] })
        );
        expect(told).toBe(2);
        expect(marks).toStrictEqual([]);
      })
  );

  it.effect(
    "dies naming the tasks option for a task the object has none of",
    () =>
      Effect.gen(function* () {
        const { result, marks } = yield* inObject((state) =>
          tellingOver(state, Effect.void).tasks.runAfter("unknown", Effect.void)
        );

        expect(
          Exit.isFailure(result) && Cause.squash(result.cause)
        ).toStrictEqual(
          new Error(
            "ActionDurableObject.Tasks: this object has no task unknown (give make or handlers a tasks entry named unknown)"
          )
        );
        expect(marks).toStrictEqual([]);
      })
  );

  it.live(
    "runs make's task on the object's alarm after a change, and again when it failed",
    () =>
      Effect.gen(function* () {
        const told = env.TASKED.getByName("told");
        const retried = env.TASKED.getByName("retried");

        yield* Effect.promise(async () => {
          await told.change();
        });
        yield* runAlarmDue(told);

        yield* Effect.promise(async () => {
          await retried.down(true);
        });
        yield* Effect.promise(async () => {
          await retried.change();
        });
        yield* runAlarmDue(retried);

        const whileDown = yield* Effect.promise(
          async () => await retried.told()
        );

        yield* Effect.promise(async () => {
          await retried.down(false);
        });
        yield* runAlarmDue(retried);

        expect(yield* Effect.promise(async () => await told.told())).toBe(1);
        expect([
          whileDown,
          yield* Effect.promise(async () => await retried.told()),
        ]).toStrictEqual([0, 1]);
      })
  );

  it.live(
    "runs make's task changed by a route's handler, which reads the object's services",
    () =>
      Effect.gen(function* () {
        const tasked = env.TASKED.getByName("routed");

        const response = yield* Effect.promise(
          async () =>
            await tasked.fetch("https://object/change", { method: "POST" })
        );

        yield* runAlarmDue(tasked);

        expect([
          response.status,
          yield* Effect.promise(async () => await tasked.told()),
        ]).toStrictEqual([204, 1]);
      })
  );
});
