import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { Clock, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { alarmPrefix, makeSchedule } from "../../src/durable/alarm.js";

const hour = 60 * 60 * 1000;

let objects = 0;

const inObject = <A, E>(
  use: (
    schedule: ReturnType<typeof makeSchedule>,
    start: number,
    state: DurableObjectState,
  ) => Effect.Effect<A, E>,
) =>
  Effect.promise(() =>
    runInDurableObject(env.ROUTER_PROVIDED.getByName(`schedule-${objects++}`), (_, state) => {
      const start = Date.now();

      return Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(start);

          const result = yield* Effect.exit(use(makeSchedule(state), start, state));
          const alarm = yield* Effect.promise(() => state.storage.getAlarm());

          return { result, alarm, start };
        }).pipe(Effect.provide(TestClock.layer())),
      );
    }),
  );

const recording = (ran: Array<string>, name: string) => () =>
  Effect.sync(() => void ran.push(name));

describe("the alarm schedule", () => {
  it.effect("sets the runtime alarm for the earliest owner's time, and deletes it with none", () =>
    Effect.gen(function* () {
      const both = yield* inObject((schedule, start) =>
        Effect.andThen(
          schedule.set("later", start + 2 * hour),
          schedule.set("sooner", start + hour),
        ),
      );

      const cleared = yield* inObject((schedule, start) =>
        Effect.all([
          schedule.set("later", start + 2 * hour),
          schedule.set("sooner", start + hour),
          schedule.clear("sooner"),
        ]),
      );

      const none = yield* inObject((schedule, start) =>
        Effect.andThen(schedule.set("only", start + hour), schedule.clear("only")),
      );

      expect(both.alarm).toBe(both.start + hour);
      expect(cleared.alarm).toBe(cleared.start + 2 * hour);
      expect(none.alarm).toBeNull();
    }),
  );

  it.effect("runs each owner whose time has come, and sets the alarm for the next", () =>
    Effect.gen(function* () {
      const ran: Array<string> = [];

      const { result, alarm, start } = yield* inObject((schedule, start) =>
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
        }),
      );

      expect(result).toEqual(Exit.void);
      expect(ran).toEqual(["first", "second"]);
      expect(alarm).toBe(start + 3 * hour);
    }),
  );

  it.effect("runs no owner before its time at a repeated firing, and keeps the alarm for it", () =>
    Effect.gen(function* () {
      const ran: Array<string> = [];

      const { alarm, start } = yield* inObject((schedule, start) =>
        Effect.gen(function* () {
          const owners = { sooner: recording(ran, "sooner"), later: recording(ran, "later") };

          yield* schedule.set("sooner", start + hour);
          yield* schedule.set("later", start + 2 * hour);
          yield* TestClock.setTime(start + hour);
          yield* schedule.runDue(owners);
          yield* schedule.runDue(owners);
        }),
      );

      expect(ran).toEqual(["sooner"]);
      expect(alarm).toBe(start + 2 * hour);
    }),
  );

  it.effect(
    "retries a failed owner 2 seconds later, doubling, six times, then hourly, running the others",
    () =>
      Effect.gen(function* () {
        const retries: Array<number> = [];
        const ran: Array<string> = [];

        const { result, alarm } = yield* inObject((schedule, start, state) =>
          Effect.gen(function* () {
            const alarms: Array<number | null> = [];

            yield* schedule.set("failing", start + hour);
            yield* schedule.set("passing", start + hour);
            yield* TestClock.setTime(start + hour);

            for (let run = 0; run < 8; run++) {
              yield* schedule.runDue({
                failing: ({ retryCount }) =>
                  Effect.andThen(
                    Effect.sync(() => void retries.push(retryCount)),
                    Effect.fail("unreachable"),
                  ),
                passing: recording(ran, "passing"),
              });

              const now = yield* Clock.currentTimeMillis;
              const next = yield* Effect.promise(() => state.storage.getAlarm());

              alarms.push(next === null ? null : next - now);

              if (next !== null) yield* TestClock.setTime(next);
            }

            return alarms;
          }),
        );

        expect(result).toEqual(
          Exit.succeed([2000, 4000, 8000, 16_000, 32_000, 64_000, hour, hour]),
        );
        expect(retries).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(ran).toEqual(["passing"]);
        expect(alarm).not.toBeNull();
      }),
  );

  it.effect(
    "runs an owner again whose run was cut off, at the alarm it set first, counted as a failure, and keeps the next time a run sets",
    () =>
      Effect.gen(function* () {
        const ran: Array<string> = [];
        const armed: Array<number | null> = [];

        const { result, alarm, start } = yield* inObject((schedule, start, state) =>
          Effect.gen(function* () {
            yield* schedule.set("digest", start + hour);
            yield* TestClock.setTime(start + hour);

            const cut = yield* Effect.forkChild(
              schedule.runDue({
                digest: ({ retryCount }) =>
                  Effect.promise(() => state.storage.getAlarm()).pipe(
                    Effect.tap((at) => Effect.sync(() => void armed.push(at))),
                    Effect.andThen(recording(ran, `cut off at ${retryCount}`)()),
                    Effect.andThen(Effect.never),
                  ),
              }),
            );

            yield* TestClock.adjust("0 millis");
            yield* Fiber.interrupt(cut);
            yield* TestClock.setTime(start + hour + 2000);

            yield* schedule.runDue({
              digest: ({ retryCount }) =>
                Effect.andThen(
                  recording(ran, `retried at ${retryCount}`)(),
                  schedule.set("digest", start + 25 * hour),
                ),
            });
          }),
        );

        expect(result).toEqual(Exit.void);
        expect(ran).toEqual(["cut off at 0", "retried at 1"]);
        expect(armed).toEqual([start + hour + 2000]);
        expect(alarm).toBe(start + 25 * hour);
      }),
  );

  it.effect("keeps a time an owner sets from its run, the one it ran for included", () =>
    Effect.gen(function* () {
      const { result, alarm, start } = yield* inObject((schedule, start) =>
        Effect.gen(function* () {
          yield* schedule.set("batch", start + hour);
          yield* TestClock.setTime(start + hour);
          yield* schedule.runDue({
            batch: ({ scheduledTime }) => schedule.set("batch", scheduledTime),
          });
        }),
      );

      expect(result).toEqual(Exit.void);
      expect(alarm).toBe(start + hour);
    }),
  );

  it.effect("runs a later owner from its time as its turn comes, cleared or postponed before", () =>
    Effect.gen(function* () {
      const ran: Array<string> = [];

      const { result, alarm, start } = yield* inObject((schedule, start, state) =>
        Effect.gen(function* () {
          yield* schedule.set("a", start + hour);
          yield* schedule.set("b", start + hour);
          yield* schedule.set("c", start + hour);
          yield* TestClock.setTime(start + hour);
          yield* schedule.runDue({
            a: () =>
              Effect.all([
                Effect.sync(() => void ran.push("a")),
                schedule.clear("b"),
                schedule.set("c", start + 5 * hour),
              ]),
            b: recording(ran, "b"),
            c: recording(ran, "c"),
          });

          return [
            ...(yield* Effect.promise(() => state.storage.list({ prefix: alarmPrefix }))).keys(),
          ];
        }),
      );

      expect(result).toEqual(Exit.succeed([`${alarmPrefix}c`]));
      expect(ran).toEqual(["a"]);
      expect(alarm).toBe(start + 5 * hour);
    }),
  );

  it.effect("keeps a time set or cleared as a failing owner ran, in place of its retry", () =>
    Effect.gen(function* () {
      const { result, alarm, start } = yield* inObject((schedule, start, state) =>
        Effect.gen(function* () {
          yield* schedule.set("cleared", start + hour);
          yield* schedule.set("moved", start + hour);
          yield* TestClock.setTime(start + hour);
          yield* schedule.runDue({
            cleared: () => Effect.andThen(schedule.clear("cleared"), Effect.fail("unreachable")),
            moved: () =>
              Effect.andThen(schedule.set("moved", start + 5 * hour), Effect.fail("unreachable")),
          });

          return [...(yield* Effect.promise(() => state.storage.list({ prefix: alarmPrefix })))];
        }),
      );

      expect(result).toEqual(
        Exit.succeed([[`${alarmPrefix}moved`, { at: start + 5 * hour, failures: 0 }]]),
      );
      expect(alarm).toBe(start + 5 * hour);
    }),
  );

  it.effect("times a failed owner's retry from its failure, however long it ran", () =>
    Effect.gen(function* () {
      const { result } = yield* inObject((schedule, start, state) =>
        Effect.gen(function* () {
          yield* schedule.set("slow", start + hour);
          yield* TestClock.setTime(start + hour);

          yield* schedule.runDue({
            slow: () => Effect.andThen(TestClock.adjust("5 seconds"), Effect.fail("unreachable")),
          });

          const now = yield* Clock.currentTimeMillis;
          const next = yield* Effect.promise(() => state.storage.getAlarm());

          return next === null ? null : next - now;
        }),
      );

      expect(result).toEqual(Exit.succeed(2000));
    }),
  );

  it.effect("drops the time of an owner the alarm does not run", () =>
    Effect.gen(function* () {
      const { result, alarm } = yield* inObject((schedule, start) =>
        Effect.all(
          [
            schedule.set("removed", start + hour),
            TestClock.setTime(start + hour),
            schedule.runDue<never>({}),
          ],
          { discard: true },
        ),
      );

      expect(result).toEqual(Exit.void);
      expect(alarm).toBeNull();
    }),
  );

  it.live("sets the alarm again as an instance builds, for the times kept with none set", () =>
    Effect.gen(function* () {
      const stub = env.ROUTER_PROVIDED.getByName("restored");

      const kept = yield* Effect.promise(() =>
        runInDurableObject(stub, async (_, state) => {
          const at = Date.now() + hour;

          await state.storage.put(`${alarmPrefix}application`, { at, failures: 0 });

          return at;
        }),
      );

      yield* Effect.promise(() => evictDurableObject(stub));
      yield* Effect.promise(() => stub.fetch("https://object/unrouted"));

      const alarm = yield* Effect.promise(() =>
        runInDurableObject(stub, (_, state) => state.storage.getAlarm()),
      );

      expect(alarm).toBe(kept);
    }),
  );

  it.live("retries a failing alarm option at its backoff through the runtime's own alarm", () =>
    Effect.gen(function* () {
      const failing = env.FAILING.getByName("failing");

      yield* Effect.promise(() => failing.arm());
      yield* Effect.sleep("3 seconds");

      expect(yield* Effect.promise(() => failing.runs())).toBe(2);
    }),
  );
});
