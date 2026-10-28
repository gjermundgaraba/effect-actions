import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import { Effect, Layer } from "effect";
import { Command } from "effect/cli";

import { Operator } from "./admin/Admin.js";
import type { TrustedOperator } from "./admin/Admin.js";
import { Grants } from "./admin/grants.js";
import { admin } from "./admin/handlers.js";
import { WorkspaceRegistry } from "./workspaces/registry.js";

const operator: TrustedOperator = { id: "console", trusted: true };

const ops = ActionCli.make(admin, {
  name: "tracker-ops",
  commands: {
    listWorkspaces: {
      render: ({ workspaces }) =>
        workspaces
          .map(
            ({ slug, name, suspended }) =>
              `${slug}  ${name}${suspended ? "  (suspended)" : ""}`
          )
          .join("\n"),
    },
    suspendWorkspace: { positional: ["workspace"] },
    resumeWorkspace: { positional: ["workspace"] },
  },
}).pipe(
  Command.provide(Layer.merge(WorkspaceRegistry.layerMemory, Grants.layerDemo)),
  Command.provideSync(Operator, operator)
);

Command.run(ops, { version: "1.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  ActionCli.logToStderr,
  NodeRuntime.runMain()
);
