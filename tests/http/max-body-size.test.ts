import { NodeHttpServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ByteSize, Effect, Layer, Schema } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
} from "effect/http";

import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import { mcpRequest, post } from "../support/requests.js";
import { serve } from "../support/serve.js";

const Echo = Action.make("echo", {
  description: "Echo the text",
  readOnly: false,
  caller: Action.Anyone,
  input: Schema.Struct({ text: Schema.String }),
  success: Schema.String,
});

const app = Action.implement(Echo, ({ text }) => Effect.succeed(text));

describe("MaxBodySize", () => {
  it.effect(
    "limits the body of the library's routes and MCP endpoints to the host's startup MaxBodySize, answering an oversized request an empty 413",
    () =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;

        const route = (text: string) =>
          client.execute(
            HttpClientRequest.post("/api/echo").pipe(
              HttpClientRequest.bodyJsonUnsafe({ text })
            )
          );

        const tool = (text: string) =>
          client.execute(
            ActionMcp.request(
              "tools/call",
              { name: "echo", arguments: { text } },
              { url: "/mcp" }
            )
          );

        const small = "x".repeat(16);
        const large = "x".repeat(4096);

        expect((yield* route(small)).status).toBe(200);
        expect((yield* tool(small)).status).toBe(200);

        for (const response of [yield* route(large), yield* tool(large)]) {
          expect([response.status, yield* response.text]).toStrictEqual([
            413,
            "",
          ]);
        }
      }).pipe(
        Effect.provide(
          HttpRouter.serve(
            Layer.mergeAll(
              ActionHttp.layer(ActionHttp.make([Echo]), app),
              ActionMcp.layerHttp(app, { name: "test", version: "0" })
            ),
            { disableLogger: true, disableListenLog: true }
          ).pipe(
            Layer.provide(
              Layer.succeed(HttpServerRequest.MaxBodySize, ByteSize.bytes(1024))
            ),
            Layer.provideMerge(NodeHttpServer.layerTest)
          )
        )
      )
  );

  it("limits ActionHttp's routes alone under HttpRouter.toWebHandler by Layer.provide", async () => {
    const { handler } = serve(
      Layer.mergeAll(
        ActionHttp.layer(ActionHttp.make([Echo]), app),
        ActionMcp.layerHttp(app, { name: "test", version: "0" })
      ).pipe(
        Layer.provide(
          Layer.succeed(HttpServerRequest.MaxBodySize, ByteSize.bytes(1024))
        )
      )
    );

    const large = "x".repeat(4096);

    const route = await handler(post("/api/echo", { text: large }));

    const tool = await handler(
      mcpRequest({
        method: "tools/call",
        params: { name: "echo", arguments: { text: large } },
      })
    );

    expect([route.status, tool.status]).toStrictEqual([413, 200]);
  });

  it("limits both surfaces under HttpRouter.toWebHandler by HttpRouter.provideRequest", async () => {
    const { handler } = serve(
      Layer.mergeAll(
        ActionHttp.layer(ActionHttp.make([Echo]), app),
        ActionMcp.layerHttp(app, { name: "test", version: "0" })
      ).pipe(
        HttpRouter.provideRequest(
          Layer.succeed(HttpServerRequest.MaxBodySize, ByteSize.bytes(1024))
        )
      )
    );

    const large = "x".repeat(4096);

    const route = await handler(post("/api/echo", { text: large }));

    const tool = await handler(
      mcpRequest({
        method: "tools/call",
        params: { name: "echo", arguments: { text: large } },
      })
    );

    expect([route.status, await route.text()]).toStrictEqual([413, ""]);
    expect([tool.status, await tool.text()]).toStrictEqual([413, ""]);
  });
});
