import { Effect } from "effect";
import * as Action from "../src/Action.js";
import { actors, CurrentActor } from "./authorization.js";
import { userActions } from "./handlers.js";
import { Users } from "./users.js";

// Each call names its caller, as authentication names one per request.
const asAlice = Effect.provideService(CurrentActor, actors.alice);

const asReader = Effect.provideService(CurrentActor, actors.reader);

const program = Effect.gen(function* () {
  // Acquired once, as a layer is built: the builders run here, not per call.
  const users = yield* Action.client(userActions);

  // The methods of `ActionHttp.client(Http)`, with no transport between: each call decodes
  // its input, runs the hook, then the handler, and checks the success or the failure.
  const renamed = yield* users.renameUser({ id: "1", name: "Bea" }).pipe(asAlice);
  const refused = yield* Effect.flip(users.renameUser({ id: "1", name: "Cy" }).pipe(asReader));
  const { changes } = yield* users.listChanges().pipe(asReader); // not an HTTP route

  return { renamed, refused, changes };
});

// The builders are released with the program's scope, before the services they captured.
console.log(
  await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(Users.layerMemory))),
);
