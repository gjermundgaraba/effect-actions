import { Context, Effect, Layer, Ref, Semaphore } from "effect";

import type { Task } from "./Tasks.js";
import { TaskNotFound } from "./Tasks.js";

type TaskList = readonly Task[];

// Every method reads the whole list, and a change writes it back: a layer says only where the
// list is kept, in memory below or in a file (src/platform/tasks-file.ts).
const make = (
  load: Effect.Effect<TaskList>,
  save: (tasks: TaskList) => Effect.Effect<void>
) => {
  // A model's tool calls in one turn run concurrently. Two changes reading the list before
  // either writes it would lose one, so a change holds this lock from its read to its write.
  const lock = Semaphore.makeUnsafe(1);

  const change = Effect.fn("TaskStore.change")(function* (
    id: string,
    to: (task: Task) => Task
  ) {
    const tasks = yield* load;
    const task = tasks.find((each) => each.id === id);

    if (task === undefined) {
      return yield* new TaskNotFound({ id });
    }

    const changed = to(task);

    yield* save(tasks.map((each) => (each.id === id ? changed : each)));

    return changed;
  }, Semaphore.withPermit(lock));

  return TaskStore.of({
    list: (assignee) =>
      Effect.map(load, (tasks) =>
        assignee === undefined
          ? tasks
          : tasks.filter((task) => task.assignee === assignee)
      ),
    add: Effect.fn("TaskStore.add")(function* (addedBy, title, assignee) {
      const tasks = yield* load;

      const task = {
        id: `${tasks.length + 1}`,
        title,
        assignee,
        addedBy,
        notes: "",
        done: false,
      };

      yield* save([...tasks, task]);

      return task;
    }, Semaphore.withPermit(lock)),
    complete: (id) => change(id, (task) => ({ ...task, done: true })),
    annotate: (id, notes) => change(id, (task) => ({ ...task, notes })),
  });
};

/** The team's tasks. Its methods require nothing: a layer captures where the tasks are kept. */
export class TaskStore extends Context.Service<
  TaskStore,
  {
    readonly list: (assignee: string | undefined) => Effect.Effect<TaskList>;
    readonly add: (
      addedBy: string,
      title: string,
      assignee: string
    ) => Effect.Effect<Task>;
    readonly complete: (id: string) => Effect.Effect<Task, TaskNotFound>;
    readonly annotate: (
      id: string,
      notes: string
    ) => Effect.Effect<Task, TaskNotFound>;
  }
>()("assistant/TaskStore") {
  /** The store over a list kept by `load` and `save`, each change serialized. */
  static readonly make = make;

  /** Memory, lost with the process: what a test provides. */
  static readonly layerMemory = Layer.effect(
    TaskStore,
    Effect.map(Ref.make<TaskList>([]), (tasks) =>
      make(Ref.get(tasks), (next) => Ref.set(tasks, next))
    )
  );
}
