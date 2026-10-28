import { tmpdir } from "node:os";
import path from "node:path";

import { Config, Effect, FileSystem, Layer, Schema } from "effect";

import { TaskStore } from "../tasks/store.js";
import { Task } from "../tasks/Tasks.js";

const TasksFile = Schema.fromJsonString(Schema.Array(Task));

export const demoTasksFile = Layer.effect(
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
        Effect.tap(() => Effect.log(`Saved ${tasks.length} tasks to ${file}.`)),
        Effect.orDie
      );

    return TaskStore.make(load, save);
  })
);
