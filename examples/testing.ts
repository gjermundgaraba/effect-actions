import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import * as Testing from "../src/Testing.js";
import * as TestingClient from "../src/TestingClient.js";
import { Http, routes } from "./quickstart.js";

const web = HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)));

try {
  const greeting = await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* Testing.httpClient(Http.api, web.handler);

      return yield* client.greetings.greet({ payload: { name: "Ada" } });
    }),
  );

  // Raw MCP request; this stateless revision needs no initialize handshake.
  const listed = await web.handler(
    Testing.mcpRequest({ url: "http://localhost/mcp", method: "tools/list" }),
  );

  // One tool call, answered as `{ isError: false, value: "Hello, Ada!" }`.
  const called = await Testing.mcpCall(web.handler, {
    url: "http://localhost/mcp",
    name: "greet",
    arguments: { name: "Ada" },
  });

  // The official client uses the same in-memory handler.
  const result = await TestingClient.withMcpClient({ fetch: web.handler, path: "/mcp" }, (client) =>
    client.callTool({ name: "greet", arguments: { name: "Ada" } }),
  );

  console.log({ greeting, listStatus: listed.status, called, result });
} finally {
  await web.dispose();
}
