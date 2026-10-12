import { NodeRuntime, NodeStdio } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { serverInfo } from "./instructions.js";
import { fakeFarm } from "./printers/fake.js";
import { PrintFarm } from "./printers/farm.js";
import { printers } from "./printers/handlers.js";

// Entrypoint: an MCP server a local agent starts as a subprocess, with FARM_URL, FARM_USER and
// FARM_PASSWORD in its environment. The README has the line that adds it to Claude Code and
// its entry in Claude Desktop's configuration.
// The same implementation and the same server information as the HTTP server, and no port:
// the agent's host starts the process, writes requests to its stdin, and closes it to stop it.
ActionMcp.runStdio(printers, serverInfo).pipe(
  Effect.provide([
    NodeStdio.layer,
    // DEMO ONLY: `fakeFarm` answers the farm's API in memory. A real server provides
    // `FetchHttpClient.layer` in its place.
    PrintFarm.layer.pipe(Layer.provide(fakeFarm)),
  ]),
  // stdout carries the protocol alone. Applied last, this sends every log to stderr, the
  // sign-in line `PrintFarm.layer` logs included, and a startup failure too.
  ActionCli.logToStderr,
  NodeRuntime.runMain,
);
