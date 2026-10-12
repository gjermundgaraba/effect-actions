import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { WorkspaceRegistry } from "./registry.js";
import { GetStatus } from "./Workspaces.js";

// One action, one handler, built once: the builder yields the registry at startup, and names
// this start of the process. Both ports serve this implementation, so what the builder makes
// tells whether they share one run of it (see `builders` in routes.ts). A public action takes
// no `authorize`: nothing would run it.
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
  }),
);
