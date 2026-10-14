import { Effect, Option } from "effect";
import { Tool, Toolkit } from "effect/ai";
import * as ActionToolkit from "@gjermundgaraba/effect-actions/ActionToolkit";
import { identity } from "./identity/handlers.js";
import { CurrentCaller, type Member } from "./identity/Identity.js";
import { tasks } from "./tasks/handlers.js";

// The implementations as a native Effect AI Toolkit: a tool per action, run in this process.
// `toolkit` goes to `LanguageModel.generateText`; `layer` holds the handlers, and requires the
// startup services their builders read. Neither holds a caller.
const actions = ActionToolkit.make([tasks, identity], {
  // One rule over every call a model makes, asked before the call runs. A read runs at once. A
  // write waits for a person to approve it, except a task the caller adds to their own list:
  // `call.name` narrows `call.input` to that action's. Without a caller, it asks.
  // This is not authorization: an approved call still passes through `authorize`.
  needsApproval: (call) =>
    !call.action.readOnly &&
    Effect.map(
      Effect.serviceOption(CurrentCaller),
      Option.match({
        onNone: () => true,
        onSome: (caller) => call.name !== "addTask" || call.input.assignee !== caller.id,
      }),
    ),
});

// A title for this assistant's approval display. The model still calls the tool `addTask`.
// The later definition wins; annotating the generated tool keeps its handler and approval rule.
export const toolkit = Toolkit.merge(
  actions.toolkit,
  Toolkit.make(actions.toolkit.tools.addTask.annotate(Tool.Title, "Add a task")),
);

export const layer = actions.layer;

// Who a turn runs as is provided around that turn, never to `layer`: one toolkit serves every
// member. This is how this example names a model's caller, and it takes a `Member`. The tools
// themselves accept any `CurrentCaller`, so keeping the operator away from a model is this
// function's doing, and that of every host using it.
export const actingFor = (member: Member) => Effect.provideService(CurrentCaller, member);
