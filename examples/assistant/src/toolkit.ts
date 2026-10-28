import * as ActionToolkit from "@gjermundgaraba/effect-actions/ActionToolkit";
import { Effect, Option } from "effect";
import { Tool, Toolkit } from "effect/ai";

import { identity } from "./identity/handlers.js";
import { CurrentCaller } from "./identity/Identity.js";
import type { Member } from "./identity/Identity.js";
import { tasks } from "./tasks/handlers.js";

const actions = ActionToolkit.make([tasks, identity], {
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

export const toolkit = Toolkit.merge(
  actions.toolkit,
  Toolkit.make(actions.toolkit.tools.addTask.annotate(Tool.Title, "Add a task"))
);

export const { layer } = actions;

export const actingFor = (member: Member) =>
  Effect.provideService(CurrentCaller, member);
