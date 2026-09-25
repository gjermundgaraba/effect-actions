import { Effect } from "effect";
import * as ActionHttpClient from "../src/ActionHttpClient.js";
import * as Testing from "../src/Testing.js";
import { Http, routes } from "./quickstart.js";

const program = Effect.gen(function* () {
  const client = yield* ActionHttpClient.make(Http);
  const greeting = yield* client.greet({ name: "Ada" });

  // One tool call to `/mcp`, answered as `{ isError: false, value: "Hello, Ada!" }`.
  const called = yield* Testing.mcpCall({ name: "greet", arguments: { name: "Ada" } });

  return { greeting, called };
});

// The routes answer in memory for the program's scope, and are released after it.
console.log(await Effect.runPromise(program.pipe(Effect.provide(Testing.layer(routes)))));
