import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as ActionHttp from "../src/ActionHttp.js";
import * as Testing from "../src/Testing.js";
import { authenticate } from "./authentication.js";
import { Http } from "./binding.js";
import { userActions } from "./handlers.js";
import { Users } from "./users.js";

// The routes behind their real authentication; the caller is the token each client sends.
const routes = Testing.layer(
  ActionHttp.layer(Http, userActions).pipe(Layer.provide(authenticate)),
).pipe(Layer.provideMerge(Users.layerMemory));

const as = (token: string) => ({
  transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
});

const program = Effect.gen(function* () {
  const reader = yield* ActionHttp.client(Http, as("reader"));
  const refused = yield* Effect.flip(reader.renameUser({ id: "1", name: "Bea" })); // Forbidden
  const users = yield* Users;

  return { refused, unchanged: yield* users.get("acme", "1") };
});

console.log(await Effect.runPromise(program.pipe(Effect.provide(routes))));
