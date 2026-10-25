import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { alarmPrefix, makeSchedule } from "../../src/durable/alarm.js";
import { makeTasks, taskOwner } from "../../src/durable/tasks.js";
import { runAlarmDue } from "../support/alarm.js";

let objects = 0;

const owner = taskOwner("tell");

const inObject = <A, E>(use: (state: DurableObjectState, start: number) => Effect.Effect<A, E>) =>
  Effect.promise(() =>
    runInDurableObject(env.ROUTER_PROVIDED.getByName(`tasks-${objects++}`), (_, state) => {
      const start = Date.now();

      return Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(start);

          const result = yield* Effect.exit(use(state, start));
          const marks = yield* Effect.promise(() => state.storage.list({ prefix: alarmPrefix }));

          return { result, marks: [...marks.keys()], start };
        }).pipe(Effect.provide(TestClock.layer())),
      );
    }),
  );

const tasksOver = (state: DurableObjectState, task: Effect.Effect<void, unknown> | undefined) =>
  makeTasks(makeSchedule(state), new Set(["tell"]), () => task).tasks;

const settled = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));

describe("an object's tasks", () => {
  it.effect("runs a task at once, and leaves no mark once it succeeds", () =>
    Effect.gen(function* () {
      let ran = 0;

      const { result, marks } = yield* inObject((state) =>
        tasksOver(
          state,
          Effect.sync(() => void ran++),
        ).runAfter("tell", Effect.void),
      );

      expect(result).toEqual(Exit.void);
      expect(ran).toBe(1);
      expect(marks).toEqual([]);
    }),
  );

  it.effect("keeps a task that failed marked, and the alarm runs it until it succeeds", () =>
    Effect.gen(function* () {
      const attempts: Array<number> = [];

      const { result, marks } = yield* inObject((state, start) =>
        Effect.gen(function* () {
          const told = Effect.suspend(() => {
            attempts.push(attempts.length);

            return attempts.length < 3 ? Effect.fail("unreachable") : Effect.void;
          });

          yield* tasksOver(state, told).runAfter("tell", Effect.void);

          const marked = yield* Effect.promise(() => state.storage.getAlarm());
          const schedule = makeSchedule(state);

          for (
            let at = marked;
            at !== null;
            at = yield* Effect.promise(() => state.storage.getAlarm())
          ) {
            yield* TestClock.setTime(at);
            yield* schedule.runDue({ [owner]: () => told });
          }

          return marked === null ? null : marked - start;
        }),
      );

      expect(result).toEqual(Exit.succeed(10_000));
      expect(attempts).toEqual([0, 1, 2]);
      expect(marks).toEqual([]);
    }),
  );

  it.effect("keeps the mark of a run cut off as it ran, which the alarm runs", () =>
    Effect.gen(function* () {
      const ran: Array<string> = [];

      const { result, marks } = yield* inObject((state) =>
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();

          const cut = yield* Effect.forkChild(
            tasksOver(
              state,
              Effect.andThen(Deferred.succeed(started, undefined), Effect.never),
            ).runAfter("tell", Effect.void),
          );

          yield* Deferred.await(started);
          yield* Fiber.interrupt(cut);

          const kept = yield* Effect.promise(() => state.storage.list({ prefix: alarmPrefix }));

          yield* TestClock.adjust("10 seconds");
          yield* makeSchedule(state).runDue({
            [owner]: () => Effect.sync(() => void ran.push("retried")),
          });

          return [...kept.keys()];
        }),
      );

      expect(result).toEqual(Exit.succeed([`${alarmPrefix}${owner}`]));
      expect(ran).toEqual(["retried"]);
      expect(marks).toEqual([]);
    }),
  );

  it.effect("runs a task asked for as it runs after it, once for all the calls that waited", () =>
    Effect.gen(function* () {
      const heard: Array<number> = [];
      let current = 1;
      let runs = 0;

      const { result } = yield* inObject((state) =>
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const gate = yield* Deferred.make<void>();

          const told = Effect.gen(function* () {
            const read = current;

            runs += 1;

            if (runs === 1) {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(gate);
            }

            heard.push(read);
          });

          const tasks = tasksOver(state, told);
          const first = yield* Effect.forkChild(tasks.runAfter("tell", Effect.void));

          yield* Deferred.await(started);
          current = 2;

          const waiting = yield* Effect.forkChild(
            Effect.all([tasks.runAfter("tell", Effect.void), tasks.runAfter("tell", Effect.void)], {
              concurrency: "unbounded",
            }),
          );

          yield* settled;
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(waiting);
        }),
      );

      expect(result).toEqual(Exit.void);
      expect(heard).toEqual([1, 2]);
    }),
  );

  it.effect("keeps a task's mark while a run asked for as another ran has yet to run", () =>
    Effect.gen(function* () {
      const { result, marks } = yield* inObject((state) =>
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const gate = yield* Deferred.make<void>();
          const next = yield* Deferred.make<void>();

          const runs = [
            Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(gate)),
            Effect.andThen(Deferred.succeed(next, undefined), Effect.never),
          ];

          const tasks = makeTasks(makeSchedule(state), new Set(["tell"]), () => runs.shift()).tasks;
          const first = yield* Effect.forkChild(tasks.runAfter("tell", Effect.void));

          yield* Deferred.await(started);

          const waiting = yield* Effect.forkChild(tasks.runAfter("tell", Effect.void));

          yield* settled;
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.join(first);
          yield* Deferred.await(next);
          yield* Fiber.interrupt(waiting);
        }),
      );

      expect(result).toEqual(Exit.void);
      expect(marks).toEqual([`${alarmPrefix}${owner}`]);
    }),
  );

  it.effect(
    "runs a task after its change, however the change ended, answering as the change did",
    () =>
      Effect.gen(function* () {
        const ran: Array<string> = [];

        const { result, marks } = yield* inObject((state) =>
          Effect.gen(function* () {
            const tasks = tasksOver(
              state,
              Effect.sync(() => void ran.push("told")),
            );

            const changed = yield* tasks.runAfter(
              "tell",
              Effect.sync(() => void ran.push("changed")).pipe(Effect.as(1)),
            );

            const refused = yield* Effect.exit(
              tasks.runAfter(
                "tell",
                Effect.andThen(
                  Effect.sync(() => void ran.push("refused")),
                  Effect.fail("no"),
                ),
              ),
            );

            return [changed, refused];
          }),
        );

        expect(result).toEqual(Exit.succeed([1, Exit.fail("no")]));
        expect(ran).toEqual(["changed", "told", "refused", "told"]);
        expect(marks).toEqual([]);
      }),
  );

  it.effect(
    "marks a task before its change, so a change cut off as it ran leaves the task to the alarm",
    () =>
      Effect.gen(function* () {
        const ran: Array<string> = [];

        const { result, marks } = yield* inObject((state) =>
          Effect.gen(function* () {
            const changed = yield* Deferred.make<void>();

            const cut = yield* Effect.forkChild(
              tasksOver(
                state,
                Effect.sync(() => void ran.push("told")),
              ).runAfter(
                "tell",
                Effect.andThen(Deferred.succeed(changed, undefined), Effect.never),
              ),
            );

            yield* Deferred.await(changed);
            yield* Fiber.interrupt(cut);

            const kept = yield* Effect.promise(() => state.storage.list({ prefix: alarmPrefix }));

            yield* TestClock.adjust("10 seconds");
            yield* makeSchedule(state).runDue({
              [owner]: () => Effect.sync(() => void ran.push("retried")),
            });

            return [...kept.keys()];
          }),
        );

        expect(result).toEqual(Exit.succeed([`${alarmPrefix}${owner}`]));
        expect(ran).toEqual(["retried"]);
        expect(marks).toEqual([]);
      }),
  );

  it.effect("keeps the mark of a change that began as a run of its task ran", () =>
    Effect.gen(function* () {
      const { result, marks } = yield* inObject((state) =>
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const gate = yield* Deferred.make<void>();
          const changing = yield* Deferred.make<void>();

          const tasks = tasksOver(
            state,
            Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(gate)),
          );

          const first = yield* Effect.forkChild(tasks.runAfter("tell", Effect.void));

          yield* Deferred.await(started);

          const change = yield* Effect.forkChild(
            tasks.runAfter(
              "tell",
              Effect.andThen(Deferred.succeed(changing, undefined), Effect.never),
            ),
          );

          yield* Deferred.await(changing);
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.join(first);
          yield* Fiber.interrupt(change);
        }),
      );

      expect(result).toEqual(Exit.void);
      expect(marks).toEqual([`${alarmPrefix}${owner}`]);
    }),
  );

  it.effect("keeps the mark of a change under way that a later run of its task began after", () =>
    Effect.gen(function* () {
      const { result, marks } = yield* inObject((state) =>
        Effect.gen(function* () {
          const changing = yield* Deferred.make<void>();
          const tasks = tasksOver(state, Effect.void);

          const change = yield* Effect.forkChild(
            tasks.runAfter(
              "tell",
              Effect.andThen(Deferred.succeed(changing, undefined), Effect.never),
            ),
          );

          yield* Deferred.await(changing);
          yield* tasks.runAfter("tell", Effect.void);
          yield* Fiber.interrupt(change);
        }),
      );

      expect(result).toEqual(Exit.void);
      expect(marks).toEqual([`${alarmPrefix}${owner}`]);
    }),
  );

  it.effect("keeps the mark of a change under way that the alarm ran its task during", () =>
    Effect.gen(function* () {
      const { result, marks } = yield* inObject((state) =>
        Effect.gen(function* () {
          const changing = yield* Deferred.make<void>();
          const schedule = makeSchedule(state);
          const { tasks, due } = makeTasks(schedule, new Set(["tell"]), () => Effect.void);

          const change = yield* Effect.forkChild(
            tasks.runAfter(
              "tell",
              Effect.andThen(Deferred.succeed(changing, undefined), Effect.never),
            ),
          );

          yield* Deferred.await(changing);
          yield* TestClock.adjust("10 seconds");
          yield* schedule.runDue({ [owner]: () => due("tell", Effect.void) });
          yield* Fiber.interrupt(change);
        }),
      );

      expect(result).toEqual(Exit.void);
      expect(marks).toEqual([`${alarmPrefix}${owner}`]);
    }),
  );

  it.effect("only marks a task run before the instance is built", () =>
    Effect.gen(function* () {
      const { result, marks } = yield* inObject((state) =>
        tasksOver(state, undefined).runAfter("tell", Effect.void),
      );

      expect(result).toEqual(Exit.void);
      expect(marks).toEqual([`${alarmPrefix}${owner}`]);
    }),
  );

  it.effect("dies naming the tasks option for a task the object has none of", () =>
    Effect.gen(function* () {
      const { result } = yield* inObject((state) =>
        tasksOver(state, Effect.void).runAfter("unknown", Effect.void),
      );

      expect(Exit.isFailure(result) && Cause.squash(result.cause)).toEqual(
        new Error(
          "ActionDurableObject.Tasks: this object has no task unknown (give make or handlers a tasks entry named unknown)",
        ),
      );
    }),
  );

  it.live("runs make's task at once, and on the object's alarm when it failed", () =>
    Effect.gen(function* () {
      const told = env.TASKED.getByName("told");
      const retried = env.TASKED.getByName("retried");

      yield* Effect.promise(() => told.change());

      yield* Effect.promise(() => retried.down(true));
      yield* Effect.promise(() => retried.change());

      const before = yield* Effect.promise(() => retried.told());

      yield* Effect.promise(() => retried.down(false));

      const ran = yield* runAlarmDue(retried);

      expect(yield* Effect.promise(() => told.told())).toBe(1);
      expect([before, ran, yield* Effect.promise(() => retried.told())]).toEqual([0, true, 1]);
    }),
  );

  it.live("runs make's task from a route's handler, which reads the object's services", () =>
    Effect.gen(function* () {
      const tasked = env.TASKED.getByName("routed");

      const response = yield* Effect.promise(() =>
        tasked.fetch("https://object/change", { method: "POST" }),
      );

      expect([response.status, yield* Effect.promise(() => tasked.told())]).toEqual([204, 1]);
    }),
  );

  it.live(
    "runs make's task after the alarm's run under way, so the newer change is told last",
    () =>
      Effect.gen(function* () {
        const tasked = env.TASKED.getByName("overlapped");

        yield* Effect.promise(() => tasked.down(true));
        yield* Effect.promise(() => tasked.change());
        yield* Effect.promise(() => tasked.down(false));
        yield* Effect.promise(() => tasked.hold());

        const alarm = yield* Effect.forkChild(runAlarmDue(tasked));

        yield* Effect.sleep("100 millis");

        const changed = yield* Effect.forkChild(Effect.promise(() => tasked.change()));

        yield* Effect.sleep("100 millis");
        yield* Effect.promise(() => tasked.release());
        yield* Fiber.join(alarm);
        yield* Fiber.join(changed);

        expect(yield* Effect.promise(() => tasked.told())).toBe(2);
      }),
  );
});
