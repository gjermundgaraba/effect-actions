import { NodeRuntime, NodeStdio } from "@effect/platform-node";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { Effect } from "effect";

import { Tools } from "./Actions.js";
import { attachments } from "./attachments/handlers.js";
import { identity } from "./identity/handlers.js";
import { CurrentMember } from "./identity/Identity.js";
import { members } from "./identity/members.js";
import { features } from "./issues/guide.js";
import { issues } from "./issues/handlers.js";
import { limiter, stores } from "./memory.js";
import { status } from "./workspaces/handlers.js";
import { WorkspaceRegistry } from "./workspaces/registry.js";

// Entrypoint: an MCP server a local agent starts as a subprocess, such as
// `claude mcp add tracker -- "$PWD/node_modules/.bin/tsx" "$PWD/examples/kitchen-sink/src/stdio.ts"`
// from the repository root. The host starts the process in a directory it chooses, so `tsx`
// and the file are named by full path.
// It lists the implementations it serves itself, and imports nothing of the HTTP router. They
// are those of the `/mcp` endpoint, with its tools and features and the same `authorize`.
// stdio is a local surface: it takes no `authentication`, since no token arrives.
ActionMcp.runStdio([status, identity, issues, attachments], {
  name: "tracker",
  version: "1.0.0",
  actions: Tools,
  features,
}).pipe(
  // The host names the caller itself, around every call. DEMO ONLY: a real host reads who
  // started it, from its own login or configuration.
  Effect.provideService(CurrentMember, members.ada),
  Effect.provide([
    NodeStdio.layer,
    stores,
    limiter,
    WorkspaceRegistry.layerMemory,
  ]),
  // stdout carries the protocol alone, so logs and failures go to stderr.
  ActionCli.logToStderr,
  NodeRuntime.runMain()
);
