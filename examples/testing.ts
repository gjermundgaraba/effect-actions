import { Effect } from "effect";
import * as Testing from "../src/Testing.js";
import { Http, routes } from "./quickstart.js";

const server = Testing.serve(routes);

try {
  const greeting = await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* Testing.httpClient(Http, server);

      return yield* client.greet({ name: "Ada" });
    }),
  );

  // One tool call to `/mcp`, answered as `{ isError: false, value: "Hello, Ada!" }`.
  const called = await Testing.mcpCall(server, { name: "greet", arguments: { name: "Ada" } });

  console.log({ greeting, called });
} finally {
  await server.dispose();
}
