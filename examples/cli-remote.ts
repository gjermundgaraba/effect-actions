import { Command } from "effect/unstable/cli";
import { Cause, Console, Effect, Logger, Runtime } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { NodeHttpClient, NodeRuntime, NodeServices } from "@effect/platform-node";
import * as ActionCli from "../src/ActionCli.js";
import { Http } from "./binding.js";
import { Status } from "./contracts.js";

// From a binding rather than an implementation, the command calls the server instead.
const command = ActionCli.command(Http, Status);

Command.runWith(command, { version: "0.1.0" })(process.argv.slice(2)).pipe(
  // The host's client is the connection: where it sends, and any credentials.
  Effect.updateService(
    HttpClient.HttpClient,
    HttpClient.mapRequest(HttpClientRequest.prependUrl("http://127.0.0.1:3000")),
  ),
  // Report a failure as runMain would, but on stderr, and none the CLI has printed.
  Effect.tapCause((cause) =>
    Cause.hasInterruptsOnly(cause) || !Runtime.getErrorReported(Cause.squash(cause))
      ? Effect.void
      : Console.error(Cause.pretty(cause)),
  ),
  Effect.provideService(Logger.LogToStderr, true),
  Effect.provide(NodeHttpClient.layerUndici),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
