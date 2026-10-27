import { tmpdir } from "node:os";
import path from "node:path";

import { Config, Effect, FileSystem, Layer, Schema } from "effect";

import { TaskStore } from "../tasks/store.js";
import { Task } from "../tasks/Tasks.js";

const TasksFile = Schema.fromJsonString(Schema.Array(Task));

// DEMO ONLY: one JSON file, rewritten on every change. Changes are serialized within a
// process, by the store's lock, but nothing locks the file across processes: the agent and a
// command writing at once lose a task. A real application uses a database. The agent and the
// commands are separate processes: this file is what lets one see what the other wrote.
export const tasksFile = Layer.effect(
  TaskStore,
  Effect.gen(function* () {
    const files = yield* FileSystem.FileSystem;

    const file = yield* Config.String("ASSISTANT_TASKS").pipe(
      Config.withDefault(path.join(tmpdir(), "assistant-tasks.json"))
    );

    const load = files.readFileString(file).pipe(
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.succeed("[]")
      ),
      Effect.flatMap(Schema.decodeEffect(TasksFile)),
      Effect.orDie
    );

    const save = (tasks: readonly Task[]) =>
      Schema.encodeEffect(TasksFile)(tasks).pipe(
        Effect.flatMap((json) => files.writeFileString(file, json)),
        // A log, not a result: a command sends its handler's logs to stderr.
        Effect.tap(() => Effect.log(`Saved ${tasks.length} tasks to ${file}.`)),
        Effect.orDie
      );

    return TaskStore.make(load, save);
  })
);
