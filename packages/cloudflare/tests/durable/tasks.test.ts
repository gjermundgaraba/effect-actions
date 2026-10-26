import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { alarmPrefix, makeSchedule } from "../../src/durable/alarm.js";
import { makeTasks, taskOwner } from "../../src/durable/tasks.js";
import { runAlarmDue } from "../support/alarm.js";

let objects = 0;

const mark = `${alarmPrefix}${taskOwner("tell")}`;

const pastTheRuntimesAlarm = 60 * 60 * 1000;

const inObject = <A, E>(use: (state: DurableObjectState, start: number) => Effect.Effect<A, E>) =>
  Effect.promise(() =>
    runInDurableObject(env.ROUTER_PROVIDED.getByName(`tasks-${objects++}`), (_, state) => {
      const start = Date.now() + pastTheRuntimesAlarm;

      return Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(start);

          const result = yield* Effect.exit(use(state, start));
          const marks = yield* marksIn(state);

          return { result, marks };
        }).pipe(Effect.provide(TestClock.layer())),
      );
    }),
  );

const marksIn = (state: DurableObjectState) =>
  Effect.promise(async () => [...(await state.storage.list({ prefix: alarmPrefix })).keys()]);

const tellingOver = (state: DurableObjectState, tell: Effect.Effect<void, unknown>) => {
  const schedule = makeSchedule(state);
  const { tasks, owners } = makeTasks(schedule, { tell });

  return { tasks, alarm: schedule.runDue(owners) };
};

describe("an object's tasks", () => {
  it.effect(
    "marks a task due now, and runs it on the alarm after its change, leaving no mark once it succeeds",
    () =>
      Effect.gen(function* () {
        const ran: Array<string> = [];

        const { result, marks } = yield* inObject((state, start) =>
          Effect.gen(function* () {
            const { tasks, alarm } = tellingOver(
              state,
              Effect.sync(() => void ran.push("told")),
            );

            const changed = yield* tasks.runAfter(
              "tell",
              Effect.sync(() => ran.push("changed")),
            );

            const due = yield* Effect.promise(() => state.storage.get<{ at: number }>(mark));
            const beforeTheAlarm = [...ran];

            yield* alarm;

            return { changed, dueIn: due === undefined ? null : due.at - start, beforeTheAlarm };
          }),
        );

        expect(result).toEqual(Exit.succeed({ changed: 1, dueIn: 0, beforeTheAlarm: ["changed"] }));
        expect(ran).toEqual(["changed", "told"]);
        expect(marks).toEqual([]);
      }),
  );

  it.effect("runs a task after a change that failed, which fails as the change did", () =>
    Effect.gen(function* () {
      const ran: Array<string> = [];

      const { result, marks } = yield* inObject((state) =>
        Effect.gen(function* () {
          const { tasks, alarm } = tellingOver(
            state,
            Effect.sync(() => void ran.push("told")),
          );

          const refused = yield* Effect.exit(tasks.runAfter("tell", Effect.fail("no")));

          yield* alarm;

          return refused;
        }),
      );

      expect(result).toEqual(Exit.succeed(Exit.fail("no")));
      expect(ran).toEqual(["told"]);
      expect(marks).toEqual([]);
    }),
  );

  it.effect("keeps a task that failed marked, and the alarm retries it until it succeeds", () =>
    Effect.gen(function* () {
      let attempts = 0;

      const { result, marks } = yield* inObject((state) =>
        Effect.gen(function* () {
          const { tasks, alarm } = tellingOver(
            state,
            Effect.suspend(() => (++attempts < 3 ? Effect.fail("unreachable") : Effect.void)),
          );

          yield* tasks.runAfter("tell", Effect.void);

          for (
            let at = yield* Effect.promise(() => state.storage.getAlarm());
            at !== null;
            at = yield* Effect.promise(() => state.storage.getAlarm())
          ) {
            yield* TestClock.setTime(at);
            yield* alarm;
          }
        }),
      );

      expect(result).toEqual(Exit.void);
      expect(attempts).toBe(3);
      expect(marks).toEqual([]);
    }),
  );

  it.effect("marks a task before its change, so a crash during the change leaves it marked", () =>
    Effect.gen(function* () {
      const { result } = yield* inObject((state) =>
        Effect.gen(function* () {
          const changing = yield* Deferred.make<void>();
          const { tasks } = tellingOver(state, Effect.void);

          const change = yield* Effect.forkChild(
            tasks.runAfter(
              "tell",
              Effect.andThen(Deferred.succeed(changing, undefined), Effect.never),
            ),
          );

          yield* Deferred.await(changing);

          const during = yield* marksIn(state);

          yield* Fiber.interrupt(change);

          return during;
        }),
      );

      expect(result).toEqual(Exit.succeed([mark]));
    }),
  );

  it.effect("runs a task once for the changes made before the alarm runs it", () =>
    Effect.gen(function* () {
      let told = 0;

      const { result, marks } = yield* inObject((state) =>
        Effect.gen(function* () {
          const { tasks, alarm } = tellingOver(
            state,
            Effect.sync(() => void told++),
          );

          yield* tasks.runAfter("tell", Effect.void);
          yield* tasks.runAfter("tell", Effect.void);
          yield* alarm;
        }),
      );

      expect(result).toEqual(Exit.void);
      expect(told).toBe(1);
      expect(marks).toEqual([]);
    }),
  );

  it.effect("runs a task again for a change that ended after the alarm ran it", () =>
    Effect.gen(function* () {
      let told = 0;

      const { result, marks } = yield* inObject((state) =>
        Effect.gen(function* () {
          const changing = yield* Deferred.make<void>();
          const ended = yield* Deferred.make<void>();

          const { tasks, alarm } = tellingOver(
            state,
            Effect.sync(() => void told++),
          );

          const change = yield* Effect.forkChild(
            tasks.runAfter(
              "tell",
              Effect.andThen(Deferred.succeed(changing, undefined), Deferred.await(ended)),
            ),
          );

          yield* Deferred.await(changing);
          yield* alarm;

          const afterTheFirstRun = yield* marksIn(state);

          yield* Deferred.succeed(ended, undefined);
          yield* Fiber.join(change);

          const afterTheChange = yield* marksIn(state);

          yield* alarm;

          return { afterTheFirstRun, afterTheChange };
        }),
      );

      expect(result).toEqual(Exit.succeed({ afterTheFirstRun: [], afterTheChange: [mark] }));
      expect(told).toBe(2);
      expect(marks).toEqual([]);
    }),
  );

  it.effect("dies naming the tasks option for a task the object has none of", () =>
    Effect.gen(function* () {
      const { result, marks } = yield* inObject((state) =>
        tellingOver(state, Effect.void).tasks.runAfter("unknown", Effect.void),
      );

      expect(Exit.isFailure(result) && Cause.squash(result.cause)).toEqual(
        new Error(
          "ActionDurableObject.Tasks: this object has no task unknown (give make or handlers a tasks entry named unknown)",
        ),
      );
      expect(marks).toEqual([]);
    }),
  );

  it.live("runs make's task on the object's alarm after a change, and again when it failed", () =>
    Effect.gen(function* () {
      const told = env.TASKED.getByName("told");
      const retried = env.TASKED.getByName("retried");

      yield* Effect.promise(() => told.change());
      yield* runAlarmDue(told);

      yield* Effect.promise(() => retried.down(true));
      yield* Effect.promise(() => retried.change());
      yield* runAlarmDue(retried);

      const whileDown = yield* Effect.promise(() => retried.told());

      yield* Effect.promise(() => retried.down(false));
      yield* runAlarmDue(retried);

      expect(yield* Effect.promise(() => told.told())).toBe(1);
      expect([whileDown, yield* Effect.promise(() => retried.told())]).toEqual([0, 1]);
    }),
  );

  it.live("runs make's task changed by a route's handler, which reads the object's services", () =>
    Effect.gen(function* () {
      const tasked = env.TASKED.getByName("routed");

      const response = yield* Effect.promise(() =>
        tasked.fetch("https://object/change", { method: "POST" }),
      );

      yield* runAlarmDue(tasked);

      expect([response.status, yield* Effect.promise(() => tasked.told())]).toEqual([204, 1]);
    }),
  );
});
