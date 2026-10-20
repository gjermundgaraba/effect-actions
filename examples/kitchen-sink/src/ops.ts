import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { Command } from "effect/cli";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import { Operator, type TrustedOperator } from "./admin/Admin.js";
import { Grants } from "./admin/grants.js";
import { admin } from "./admin/handlers.js";
import { WorkspaceRegistry } from "./workspaces/registry.js";

// Entrypoint: `node --import tsx examples/kitchen-sink/src/ops.ts list-workspaces`.
// The operators' console: the admin actions run in this process, on the host's own services,
// with no server and no key.

const operator: TrustedOperator = { id: "console", trusted: true };

const ops = ActionCli.make(admin, {
  name: "tracker-ops",
  commands: {
    listWorkspaces: {
      render: ({ workspaces }) =>
        workspaces
          .map(({ slug, name, suspended }) => `${slug}  ${name}${suspended ? "  (suspended)" : ""}`)
          .join("\n"),
    },
    suspendWorkspace: { positional: ["workspace"] },
    resumeWorkspace: { positional: ["workspace"] },
  },
}).pipe(
  // Only what these actions are built from. DEMO ONLY: memory, so this console sees its own
  // process, not the server's data. A real one provides the database Layers the server does.
  Command.provide(Layer.merge(WorkspaceRegistry.layerMemory, Grants.layerDemo)),
  Command.provideSync(Operator, operator),
);

Command.run(ops, { version: "1.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  ActionCli.logToStderr,
  NodeRuntime.runMain,
);
