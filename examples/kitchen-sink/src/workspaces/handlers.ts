import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Effect } from "effect";

import { WorkspaceRegistry } from "./registry.js";
import { GetStatus } from "./Workspaces.js";

export const status = Action.implement(
  GetStatus,
  Effect.gen(function* () {
    const registry = yield* WorkspaceRegistry;
    const instance = crypto.randomUUID();

    return () =>
      Effect.map(registry.list, (workspaces) => ({
        service: "tracker",
        instance,
        workspaces: workspaces.length,
      }));
  })
);
