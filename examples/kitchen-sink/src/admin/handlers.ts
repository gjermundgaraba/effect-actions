import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Effect } from "effect";

import { WorkspaceRegistry } from "../workspaces/registry.js";
import { Admin } from "./Admin.js";
import { authorize } from "./authorize.js";

// The operators' actions. `authorize` is an Effect that builds the rule, so this
// implementation owes `Grants` at startup, beside the registry its builder yields.
export const admin = Action.implement(
  Admin,
  Effect.gen(function* () {
    const registry = yield* WorkspaceRegistry;

    return {
      listWorkspaces: () =>
        Effect.map(registry.list, (workspaces) => ({ workspaces })),
      suspendWorkspace: ({ workspace }) =>
        registry.setSuspended(workspace, true),
      resumeWorkspace: ({ workspace }) =>
        registry.setSuspended(workspace, false),
    };
  }),
  { authorize }
);
