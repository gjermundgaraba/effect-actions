import { NodeRuntime, NodeStdio } from "@effect/platform-node";
import { Effect } from "effect";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { identity } from "./identity/handlers.js";
import { CurrentUser } from "./identity/Identity.js";
import { users } from "./identity/users.js";
import { notes } from "./notes/handlers.js";
import { NoteStore } from "./notes/store.js";
import { status } from "./status/handlers.js";

// Entrypoint: an MCP server a local agent starts as a subprocess, such as
// `claude mcp add notes -- "$PWD/node_modules/.bin/tsx" "$PWD/examples/notes-service/src/stdio.ts"`
// from the repository root: mcp-tools' README says why the paths are full.
// The same implementations as the HTTP server, and the same `authorize`. No token arrives
// over stdio, so this host names the caller itself. It is a process of its own with services
// of its own: this in-memory store holds its notes, not the running server's. To share them,
// both provide a store they both reach, such as a database.
ActionMcp.runStdio([status, notes, identity], { name: "notes-service", version: "1.0.0" }).pipe(
  // DEMO ONLY: a real host reads who started it, from its own login or configuration.
  Effect.provideService(CurrentUser, users.ada),
  Effect.provide([NodeStdio.layer, NoteStore.layerMemory]),
  // stdout carries the protocol alone, so logs and failures go to stderr.
  ActionCli.logToStderr,
  NodeRuntime.runMain,
);
