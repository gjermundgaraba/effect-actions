import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { CurrentCaller, type Member, type Operator } from "../../src/identity/Identity.js";
import { members } from "../../src/identity/members.js";
import { Permissions } from "../../src/identity/permissions.js";
import { tasks } from "../../src/tasks/handlers.js";
import { TaskNotFound } from "../../src/tasks/Tasks.js";
import { TaskStore } from "../../src/tasks/store.js";

// What the implementation does, with no model and no command line: `Action.client` runs the
// same decoding, `authorize` and handler every surface runs. Each call names its caller.
const as = (caller: Member | Operator) => Effect.provideService(CurrentCaller, caller);

const operator: Operator = { kind: "operator", id: "root" };

// A test supplies its services as an entrypoint does: here the store is memory.
const services = Layer.mergeAll(TaskStore.layerMemory, Permissions.layerMemory);

describe("tasks, in process", () => {
  it.effect("records which caller added a task, a member or the operator", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(tasks);

      yield* client.addTask({ title: "Book the venue", assignee: "ada" }).pipe(as(members.ada));
      yield* client.addTask({ title: "Send invitations", assignee: "grace" }).pipe(as(operator));

      const { tasks: listed } = yield* client.listTasks().pipe(as(members.grace));

      expect(listed.map(({ id, addedBy }) => [id, addedBy])).toEqual([
        ["1", "ada"],
        ["2", "root"],
      ]);
      expect(yield* client.listTasks({ assignee: "grace" }).pipe(as(members.grace))).toMatchObject({
        tasks: [{ title: "Send invitations" }],
      });
    }).pipe(Effect.provide(services)),
  );

  it.effect("refuses a write from a member the store grants reading alone", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(tasks);
      const add = client.addTask({ title: "Order lunch", assignee: "guest" });

      const refusal = yield* Effect.flip(add.pipe(as(members.guest)));

      // `toEqual` on an error compares its fields and never its message, so the message is
      // asserted on its own.
      expect(refusal).toBeInstanceOf(Action.Forbidden);
      expect(refusal.message).toBe("Requires tasks:write.");
      expect(yield* client.listTasks().pipe(as(members.guest))).toEqual({ tasks: [] });
    }).pipe(Effect.provide(services)),
  );

  it.effect("admits the operator, whom the permission store does not know", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(tasks);
      const add = client.addTask({ title: "Rotate the keys", assignee: "ada" });
      const { id } = yield* add.pipe(as(operator));

      expect(yield* client.completeTask({ id }).pipe(as(operator))).toMatchObject({ done: true });
    }).pipe(Effect.provide(services)),
  );

  it.effect("fails with the declared error for a task that does not exist", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(tasks);
      const annotate = client.annotateTask({ id: "9", notes: "Urgent." });

      expect(yield* Effect.flip(annotate.pipe(as(members.ada)))).toEqual(
        new TaskNotFound({ id: "9" }),
      );
    }).pipe(Effect.provide(services)),
  );
});
