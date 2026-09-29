import { Effect, Layer } from "effect";
import * as ActionHttp from "../src/ActionHttp.js";
import * as Testing from "../src/Testing.js";
import { actors, CurrentActor } from "./authorization.js";
import { Http } from "./binding.js";
import { userActions } from "./handlers.js";
import { Users } from "./users.js";

// The handlers behind their hook, as one caller standing in for authentication. The
// services provided around the layer are the program's too, one instance.
const asReader = Testing.layer(ActionHttp.layer(Http, userActions)).pipe(
  Layer.provide(Layer.succeed(CurrentActor, actors.reader)),
  Layer.provideMerge(Users.layerMemory),
);

const program = Effect.gen(function* () {
  const client = yield* ActionHttp.client(Http);
  const refused = yield* Effect.flip(client.renameUser({ id: "1", name: "Bea" })); // Forbidden
  const users = yield* Users;

  return { refused, unchanged: yield* users.get("acme", "1") };
});

console.log(await Effect.runPromise(program.pipe(Effect.provide(asReader))));
