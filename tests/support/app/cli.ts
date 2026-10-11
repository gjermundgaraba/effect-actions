import { Effect } from "effect";
import { Command } from "effect/cli";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import { actors, CurrentActor } from "./authorization.js";
import { userActions } from "./handlers.js";
import { Users } from "./users.js";

const cli = ActionCli.make(userActions, { name: "users" }).pipe(
  Command.provide(Users.layerMemory),

  Command.provideSync(CurrentActor, actors.alice),
);

Command.run(cli, { version: "0.1.0" }).pipe(
  Effect.provide(NodeServices.layer),
  ActionCli.logToStderr,
  NodeRuntime.runMain,
);
