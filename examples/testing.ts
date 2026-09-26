import { Effect } from "effect";
import * as ActionHttp from "../src/ActionHttp.js";
import * as Testing from "../src/Testing.js";
import { Greet, Http, routes } from "./quickstart.js";

const program = Effect.gen(function* () {
  const client = yield* ActionHttp.client(Http);
  const greeting = yield* client.greet({ name: "Ada" });

  // The same action as one tool call to `/mcp`, typed like the client's method.
  const called = yield* Testing.mcpCall(Greet, { name: "Ada" });

  return { greeting, called };
});

// The routes answer in memory for the program's scope, and are released after it.
console.log(await Effect.runPromise(program.pipe(Effect.provide(Testing.layer(routes)))));
