import { expect, it } from "@effect/vitest";
import { ByteSize, Effect, Exit, Layer, Schema } from "effect";
import { NodeHttpServer } from "@effect/platform-node";
import { HttpClient, HttpClientRequest, HttpRouter, HttpServerRequest } from "effect/http";
import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as Testing from "../../src/testing/Testing.js";

const Echo = Action.make("echo", {
  description: "Echo the text",
  readOnly: false,
  caller: Action.Anyone,
  input: Schema.Struct({ text: Schema.String }),
  success: Schema.String,
});

const app = Action.implement(Echo, ({ text }) => Effect.succeed(text));

it.effect(
  "limits the body of the library's routes and MCP endpoints to the host's startup MaxBodySize, closing an oversized request's connection",
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
