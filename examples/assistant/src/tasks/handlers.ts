import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Effect } from "effect";

import { authorize } from "../identity/authorize.js";
import { CurrentCaller } from "../identity/Identity.js";
import { TaskStore } from "./store.js";
import { Tasks } from "./Tasks.js";

// The builder gets the store. `CurrentCaller` is read per call. No handler knows whether a model
// or a person at a terminal called it, and none checks a permission: `authorize` has run before
// it.
export const tasks = Action.implement(
  Tasks,
  Effect.gen(function* () {
    const store = yield* TaskStore;

    return {
      listTasks: ({ assignee }) =>
        Effect.map(store.list(assignee), (listed) => ({ tasks: listed })),
      addTask: ({ title, assignee }) =>
        Effect.flatMap(CurrentCaller, (caller) =>
          store.add(caller.id, title, assignee)
        ),
      completeTask: ({ id }) => store.complete(id),
      annotateTask: ({ id, notes }) => store.annotate(id, notes),
    };
  }),
  { authorize }
);
