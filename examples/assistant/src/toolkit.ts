import * as ActionToolkit from "@gjermundgaraba/effect-actions/ActionToolkit";
import { Effect, Option } from "effect";
import { Tool, Toolkit } from "effect/ai";

import { identity } from "./identity/handlers.js";
import { CurrentCaller } from "./identity/Identity.js";
import type { Member } from "./identity/Identity.js";
import { tasks } from "./tasks/handlers.js";

// `actions.layer` holds the handlers, and requires the startup services their builders read;
// neither it nor `actions.toolkit` holds a caller.
const actions = ActionToolkit.make([tasks, identity], {
  // One rule over every call a model makes, asked before the call runs. A read runs at once. A
  // write waits for a person to approve it, except a task the caller adds to their own list:
  // `call.name` narrows `call.input` to that action's. Without a caller, it asks.
  needsApproval: (call) =>
    !call.action.readOnly &&
    Effect.map(
      Effect.serviceOption(CurrentCaller),
      Option.match({
        onNone: () => true,
        onSome: (caller) =>
          call.name !== "addTask" || call.input.assignee !== caller.id,
      })
    ),
});

// A title for this assistant's approval display. The model still calls the tool `addTask`.
// The later definition wins; annotating the generated tool keeps its handler and approval rule.
export const toolkit = Toolkit.merge(
  actions.toolkit,
  Toolkit.make(actions.toolkit.tools.addTask.annotate(Tool.Title, "Add a task"))
);

export const { layer } = actions;

// One toolkit serves every member, so who a turn runs as is provided around that turn. This is
// how this example names a model's caller, and it takes a `Member`. The tools themselves accept
// any `CurrentCaller`, so keeping the operator away from a model is this function's doing, and
// that of every host using it.
export const actingFor = (member: Member) =>
  Effect.provideService(CurrentCaller, member);
