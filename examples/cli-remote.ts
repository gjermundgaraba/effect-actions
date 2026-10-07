import { Command } from "effect/cli";
import { Effect } from "effect";
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import * as ActionCli from "../src/ActionCli.js";
import { Http } from "./binding.js";
import { Status } from "./contracts.js";

// From a binding rather than implementations, the command calls the server instead. Its
// client options are the connection, as `ActionHttp.client` takes them: where it sends, and
// any credentials, which reach no other request the program makes.
const command = ActionCli.remoteCommand(Http, Status, {
  client: { baseUrl: "http://127.0.0.1:3000" },
});

Command.run(command, { version: "0.1.0" }).pipe(
  Effect.provide(NodeHttpClient.layerUndici),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
