import { Clock, Context, Effect } from "effect";

import type { Schedule } from "./alarm.js";

/** The alarm owner a task's time is kept under, one per task name. */
export const taskOwner = (name: string) => `task:${name}`;

/**
 * Runs the object's tasks, `make`'s or `handlers`' `tasks`, by name, after a change, on the
 * object's alarm until it succeeds, so the work it does, such as telling another object of the
 * change, is done at least once. A startup service, as `Alarm` is.
 *
 * **Gotchas**
 *
 * - A task runs on the alarm after the call that changed it has answered: a caller reading the object it tells at once may find it not yet told.
 * - A task reads what it sends as it runs, such as the state it announces: one run covers every change before it, so it may repeat, and the object it calls ignores what it already holds.
 * - The alarm may run a task as a change waits, on another object say, over part of that change: the change marks it again as it ends, so a run over the whole change follows.
 * - A run that fails is logged and retried as the alarm retries an owner: 2 seconds later, doubling, six times, then hourly.
 */
export class Tasks extends Context.Service<
  Tasks,
  {
    /**
     * Marks the task `name` due now in the object's storage, runs `change`, and marks it again
     * however `change` ended: the object's alarm, set for now, runs it after the call, and a
     * crash at any point leaves the mark, so the alarm still runs it.
     */
    readonly runAfter: <A, E, R>(
      name: string,
      change: Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E, R>;
  }
>()("effect-actions-cloudflare/ActionDurableObject/Tasks") {}

/**
 * The instance's `Tasks` over its `schedule`, and the alarm owners that run each of `tasks`, by
 * the name `runAfter` takes.
 */
export const makeTasks = <E, R>(
  schedule: Schedule,
  tasks: { readonly [name: string]: Effect.Effect<void, E, R> }
) => ({
  tasks: Tasks.of({
    runAfter: (name, change) =>
      Effect.gen(function* () {
        if (!Object.hasOwn(tasks, name)) {
          return yield* Effect.die(
            new Error(
              `ActionDurableObject.Tasks: this object has no task ${name} (give make or handlers a tasks entry named ${name})`
            )
          );
        }

        // Why: marked before the change, so a crash in it leaves the task to the alarm, and again
        // as it ends, as an alarm run as the change waited dropped the mark once that run ended.
        // Marked again at the same time, a mark still waiting costs a read, not a write.
        const marked = schedule.set(
          taskOwner(name),
          yield* Clock.currentTimeMillis
        );

        yield* marked;

        return yield* Effect.ensuring(change, marked);
      }),
  }),
  owners: Object.fromEntries(
    Object.entries(tasks).map(([name, task]) => [taskOwner(name), () => task])
  ),
});
