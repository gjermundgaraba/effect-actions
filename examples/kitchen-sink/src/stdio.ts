import { NodeRuntime, NodeStdio } from "@effect/platform-node";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { Effect } from "effect";

import { Tools } from "./Actions.js";
import { attachments } from "./attachments/handlers.js";
import { identity } from "./identity/handlers.js";
import { CurrentMember } from "./identity/Identity.js";
import { demoMembers } from "./identity/members.js";
import { features } from "./issues/guide.js";
import { issues } from "./issues/handlers.js";
import { limiter, stores } from "./memory.js";
import { status } from "./workspaces/handlers.js";
import { WorkspaceRegistry } from "./workspaces/registry.js";

ActionMcp.runStdio([status, identity, issues, attachments], {
  name: "tracker",
  version: "1.0.0",
  actions: Tools,
  features,
}).pipe(
  Effect.provideService(CurrentMember, demoMembers.ada),
  Effect.provide([
    NodeStdio.layer,
    stores,
    limiter,
    WorkspaceRegistry.layerMemory,
  ]),
  ActionCli.logToStderr,
  NodeRuntime.runMain()
);
