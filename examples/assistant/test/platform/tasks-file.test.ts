import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Path } from "effect";

import { demoTasksFile } from "../../src/platform/tasks-file.js";
import { TaskStore } from "../../src/tasks/store.js";

const fileStore = Effect.gen(function* () {
  const files = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* files.makeTempDirectoryScoped();
  const tasks = path.join(directory, "tasks.json");
  const config = ConfigProvider.fromUnknown({ ASSISTANT_TASKS: tasks });

  return demoTasksFile.pipe(Layer.provide(ConfigProvider.layer(config)));
});

describe("the file store", () => {
  it.effect(
    "gives each of several concurrent adds, as one model turn makes them, its own id",
    () =>
      Effect.gen(function* () {
        const store = yield* TaskStore;

        const added = yield* Effect.forEach(
          ["Book the venue", "Send invitations", "Order lunch"],
          (title) => store.add("ada", title, "ada"),
          { concurrency: "unbounded" }
        );

        expect(added.map(({ id }) => id)).toStrictEqual(["1", "2", "3"]);
        expect(yield* store.list("ada")).toStrictEqual(added);
      }).pipe(
        Effect.provide(
          Layer.unwrap(fileStore).pipe(Layer.provideMerge(NodeServices.layer))
        )
      )
  );

  it.effect(
    "keeps tasks for the next process: a layer built again reads them",
    () =>
      Effect.gen(function* () {
        const store = yield* fileStore;

        const add = Effect.flatMap(TaskStore, (tasks) =>
          tasks.add("root", "Rotate keys", "ada")
        );

        const list = Effect.flatMap(TaskStore, (tasks) =>
          tasks.list(undefined)
        );

        const task = yield* add.pipe(Effect.provide(store, { local: true }));

        expect(
          yield* list.pipe(Effect.provide(store, { local: true }))
        ).toStrictEqual([task]);
      }).pipe(Effect.provide(NodeServices.layer))
  );
});
