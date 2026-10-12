import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, Context, Effect, FileSystem, Layer, Ref, Schema, Semaphore } from "effect";
import { Task, TaskNotFound } from "./Tasks.js";

type TaskList = ReadonlyArray<Task>;

const TasksFile = Schema.fromJsonString(Schema.Array(Task));

// Every method reads the whole list, and a change writes it back: the two layers below differ
// only in where the list is kept.
const make = (load: Effect.Effect<TaskList>, save: (tasks: TaskList) => Effect.Effect<void>) => {
  // A model's tool calls in one turn run concurrently. Two changes reading the list before
  // either writes it would lose one, so a change holds this lock from its read to its write.
  const lock = Semaphore.makeUnsafe(1);

  const change = Effect.fn("TaskStore.change")(function* (id: string, to: (task: Task) => Task) {
    const tasks = yield* load;
    const task = tasks.find((each) => each.id === id);

    if (task === undefined) return yield* new TaskNotFound({ id });

    const changed = to(task);

    yield* save(tasks.map((each) => (each.id === id ? changed : each)));

    return changed;
  }, Semaphore.withPermit(lock));

  return TaskStore.of({
    list: (assignee) =>
      Effect.map(load, (tasks) =>
        assignee === undefined ? tasks : tasks.filter((task) => task.assignee === assignee),
      ),
    add: Effect.fn("TaskStore.add")(function* (addedBy, title, assignee) {
      const tasks = yield* load;
      const task = { id: `${tasks.length + 1}`, title, assignee, addedBy, notes: "", done: false };

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
    readonly add: (addedBy: string, title: string, assignee: string) => Effect.Effect<Task>;
    readonly complete: (id: string) => Effect.Effect<Task, TaskNotFound>;
    readonly annotate: (id: string, notes: string) => Effect.Effect<Task, TaskNotFound>;
  }
>()("assistant/TaskStore") {
  /** Memory, lost with the process: what a test provides. */
  static readonly layerMemory = Layer.effect(
    TaskStore,
    Effect.map(Ref.make<TaskList>([]), (tasks) =>
      make(Ref.get(tasks), (next) => Ref.set(tasks, next)),
    ),
  );

  // DEMO ONLY: one JSON file, rewritten on every change. Changes are serialized within a
  // process, by the lock above, but nothing locks the file across processes: the agent and a
  // command writing at once lose a task. A real application uses a database. The agent and the
  // commands are separate processes: this file is what lets one see what the other wrote.
  static readonly layerFile = Layer.effect(
    TaskStore,
    Effect.gen(function* () {
      const files = yield* FileSystem.FileSystem;

      const path = yield* Config.String("ASSISTANT_TASKS").pipe(
        Config.withDefault(join(tmpdir(), "assistant-tasks.json")),
      );

      const load = files.readFileString(path).pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("[]")),
        Effect.flatMap(Schema.decodeEffect(TasksFile)),
        Effect.orDie,
      );

      const save = (tasks: TaskList) =>
        Schema.encodeEffect(TasksFile)(tasks).pipe(
          Effect.flatMap((json) => files.writeFileString(path, json)),
          // A log, not a result: a command sends its handler's logs to stderr.
          Effect.tap(() => Effect.log(`Saved ${tasks.length} tasks to ${path}.`)),
          Effect.orDie,
        );

      return make(load, save);
    }),
  );
}
