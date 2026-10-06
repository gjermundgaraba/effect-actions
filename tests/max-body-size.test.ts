import { expect, it } from "@effect/vitest";
import { ByteSize, Effect, Exit, Layer, Schema } from "effect";
import { NodeHttpServer } from "@effect/platform-node";
import { HttpClient, HttpClientRequest, HttpRouter, HttpServerRequest } from "effect/http";
import * as Action from "../src/Action.js";
import * as ActionHttp from "../src/ActionHttp.js";
import * as ActionMcp from "../src/ActionMcp.js";
import * as Testing from "../src/Testing.js";

const Echo = Action.make("echo", {
  description: "Echo the text",
  access: "write",
  auth: "public",
  input: Schema.Struct({ text: Schema.String }),
  success: Schema.String,
});

const app = Action.implement(Echo, ({ text }) => Effect.succeed(text));

// The routes are built alone, with startup context beneath each request's, so the limit the
// host sets on the server still reaches the routes and MCP endpoints the library mounts.
it.effect(
  "limits the body of the library's routes and MCP endpoints to the host's MaxBodySize",
  () =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;

      const route = (text: string) =>
        client.execute(
          HttpClientRequest.post("/api/echo").pipe(HttpClientRequest.bodyJsonUnsafe({ text })),
        );

      const tool = (text: string) =>
        client.execute(
          Testing.mcpRequest("tools/call", { name: "echo", arguments: { text } }, { url: "/mcp" }),
        );

      const small = "x".repeat(16);
      const large = "x".repeat(4096);

      expect((yield* route(small)).status).toBe(200);
      expect((yield* tool(small)).status).toBe(200);

      // Node's server closes the connection of a request over the limit without a response.
      expect(Exit.isFailure(yield* Effect.exit(route(large)))).toBe(true);
      expect(Exit.isFailure(yield* Effect.exit(tool(large)))).toBe(true);
    }).pipe(
      Effect.provide(
        HttpRouter.serve(
          Layer.mergeAll(
            ActionHttp.layer(ActionHttp.make([Echo]), app),
            ActionMcp.layerHttp(app, { name: "test", version: "0" }),
          ),
          { disableLogger: true, disableListenLog: true },
        ).pipe(
          Layer.provide(Layer.succeed(HttpServerRequest.MaxBodySize, ByteSize.bytes(1024))),
          Layer.provideMerge(NodeHttpServer.layerTest),
        ),
      ),
    ),
);
