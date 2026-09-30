import { Command } from "effect/cli";
import { Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import * as ActionCli from "../src/ActionCli.js";
import { Http } from "./binding.js";
import { Status } from "./contracts.js";

// From a binding rather than an implementation, the command calls the server instead.
const command = ActionCli.command(Http, Status).pipe(
  // Its client is the connection: where it sends, and any credentials. Provided on the
  // command, it reaches no other request the program makes.
  Command.provideEffect(
    HttpClient.HttpClient,
    Effect.map(
      HttpClient.HttpClient,
      HttpClient.mapRequest(HttpClientRequest.prependUrl("http://127.0.0.1:3000")),
    ),
  ),
);

Command.run(command, { version: "0.1.0" }).pipe(
  Effect.provide(NodeHttpClient.layerUndici),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
