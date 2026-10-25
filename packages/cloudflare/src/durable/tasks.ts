import { Cause, Clock, Context, Effect, Exit, Semaphore } from "effect";
import type { Schedule } from "./alarm.js";

/** The alarm owner a task's mark is kept under, one per task name. */
export const taskOwner = (name: string) => `task:${name}`;

// Why: a task is marked this far ahead as it runs, so the alarm does not run it again as the run
// under way ends, and runs it this long after a crash or an eviction cut that run off.
const grace = 10_000;

/**
 * Runs the object's tasks, `make`'s or `handlers`' `tasks`, by name, after a change: each run in
 * the caller's fiber as the change ends, and again on the object's alarm until it succeeds, so
 * the work it does, such as telling another object of the change, is done at least once. A
 * startup service, as `Alarm` is.
 *
 * **Gotchas**
 *
 * - A task reads what it sends as it runs, such as the state it announces: one run covers every change before it, so it may repeat, and the object it calls ignores what it already holds.
 * - Runs of one task take turns, the alarm's among them: a run asked for while another is under way waits for it, so a run never sends older state after a newer one, and a call running a task waits as long as the run before it takes.
 * - A task taking a lock its callers hold as they run it, such as a semaphore every action takes, hangs both for good: the alarm's run waits for the lock, and the caller holding it waits for that run. Take no lock in a task that its callers hold.
 * - The mark is due 10 seconds on, so a change running longer has the alarm run its task every 10 seconds until the change ends, each over the state as it is then.
 * - A run that fails is logged, not the caller's failure, and retried on the alarm 10 seconds later, then as the alarm retries an owner: 2 seconds, doubling, six times, then hourly.
 * - A task run as the services build is only marked, and runs on the alarm.
 */
export class Tasks extends Context.Service<
  Tasks,
  {
    /**
     * Marks the task `name`, runs `change`, then runs the task, however `change` ended, and again
     * on the alarm until it succeeds: a crash at any point leaves the mark, so the alarm runs it.
     * Interrupted, the task is left to the alarm.
     */
    readonly runAfter: <A, E, R>(
      name: string,
      change: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("effect-actions-cloudflare/ActionDurableObject/Tasks") {}

// Why: `asked` counts the runs asked for, and `covered` is the count a run that succeeded started
// at: a run asked for before it reads no change that run did not, so its turn has nothing left to do.
// `changing` counts the changes `runAfter` marked that are under way: no run covers a change before
// it ends, so none clears the mark meanwhile.
interface Turn {
  readonly lock: Semaphore.Semaphore;
  asked: number;
  covered: number;
  changing: number;
}

/**
 * The tasks of an instance, over its `schedule`, by their `names`, each run as `provide` gives it, or `undefined`
 * before the instance is built, and `due`, which runs one on the alarm in the same turns.
 */
export const makeTasks = (
  schedule: Schedule,
  names: ReadonlySet<string>,
  provide: (name: string) => Effect.Effect<void, unknown> | undefined,
) => {
  const turns = new Map<string, Turn>();

  const turnOf = (name: string) => {
    const found = turns.get(name) ?? {
      lock: Semaphore.makeUnsafe(1),
      asked: 0,
      covered: 0,
      changing: 0,
    };

    turns.set(name, found);

    return found;
  };

  /** Runs `task` in its turn, answering the count it started at, or `undefined` if covered. */
  const inTurn = <E, R>(turn: Turn, asked: number, task: Effect.Effect<void, E, R>) =>
    turn.lock.withPermits(1)(
      Effect.suspend(() => {
        if (turn.covered >= asked) return Effect.undefined;

        const started = turn.asked;

        return Effect.map(task, () => {
          turn.covered = started;

          return started;
        });
      }),
    );

  const marked = (name: string) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) => schedule.set(taskOwner(name), now + grace));

  const turnFor = (name: string) =>
    names.has(name)
      ? Effect.sync(() => turnOf(name))
      : Effect.die(
          new Error(
            `ActionDurableObject.Tasks: this object has no task ${name} (give make or handlers a tasks entry named ${name})`,
          ),
        );

  const run = (name: string) =>
    Effect.gen(function* () {
      const owner = taskOwner(name);
      const turn = yield* turnFor(name);

      // Why: asked for before it is marked, so a run ending as it is marked sees it asked for
      // and keeps the mark; marked the other way round, that run could clear the mark just made.
      const asked = ++turn.asked;

      yield* marked(name);

      const task = provide(name);

      if (task === undefined) return;

      // Why: interrupted, the run leaves its mark, so the alarm runs the task.
      const exit = yield* Effect.exit(inTurn(turn, asked, task));

      if (Exit.isSuccess(exit)) {
        if (exit.value !== undefined && turn.asked === exit.value && turn.changing === 0) {
          yield* schedule.clear(owner);
        }

        return;
      }

      if (Cause.hasInterruptsOnly(exit.cause)) return;

      yield* Effect.logError(`The task ${name} failed: retried on the alarm`, exit.cause);
      yield* marked(name);
    });

  const tasks = Tasks.of({
    runAfter: (name, change) =>
      Effect.gen(function* () {
        const turn = yield* turnFor(name);

        turn.changing += 1;

        const exit = yield* Effect.exit(Effect.andThen(marked(name), change)).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              turn.changing -= 1;
            }),
          ),
        );

        yield* run(name);

        return yield* exit;
      }),
  });

  return {
    tasks,
    due: <E, R>(name: string, task: Effect.Effect<void, E, R>) =>
      Effect.suspend(() => {
        const turn = turnOf(name);

        // Why: the alarm drops the time of a run that succeeded, so one ending as a change is under
        // way marks the task again, as the change's own mark is the one the alarm replaced.
        return Effect.andThen(inTurn(turn, ++turn.asked, task), () =>
          turn.changing > 0 ? marked(name) : Effect.void,
        );
      }),
  };
};
