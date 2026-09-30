import { Effect } from "effect";
import { Command } from "effect/cli";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as ActionCli from "../src/ActionCli.js";
import { actors, CurrentActor } from "./authorization.js";
import { userActions } from "./handlers.js";
import { Users } from "./users.js";

// `users get-user --id 1`: a subcommand per action, a flag per input field. The
// implementation's hook runs here as on the servers; a local caller is not trusted more.
const cli = ActionCli.make(userActions, { name: "users" }).pipe(
  // Services go on the command: built when an action runs, never for `--help` or a
  // mistyped flag.
  Command.provide(Users.layerMemory),
  // No remote caller to authenticate: the host supplies the identity the hook reads.
  Command.provideSync(CurrentActor, actors.alice),
);

// Effect's own runner: the result goes to stdout, and a failure to stderr as the JSON HTTP
// sends, such as `{"_tag":"UserNotFound","id":"9"}`, exiting 1.
Command.run(cli, { version: "0.1.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
