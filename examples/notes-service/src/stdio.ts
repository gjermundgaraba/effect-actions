import { NodeRuntime, NodeStdio } from "@effect/platform-node";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { Effect } from "effect";

import { identity } from "./identity/handlers.js";
import { CurrentUser } from "./identity/Identity.js";
import { demoUsers } from "./identity/users.js";
import { notes } from "./notes/handlers.js";
import { NoteStore } from "./notes/store.js";
import { status } from "./status/handlers.js";

ActionMcp.runStdio([status, notes, identity], {
  name: "notes-service",
  version: "1.0.0",
}).pipe(
  Effect.provideService(CurrentUser, demoUsers.ada),
  Effect.provide([NodeStdio.layer, NoteStore.layerMemory]),
  ActionCli.logToStderr,
  NodeRuntime.runMain()
);
