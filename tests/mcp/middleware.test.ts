import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/ai";
import { HttpClient } from "effect/http";

import * as Action from "../../src/contract/Action.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import type { Params } from "../../src/mcp/request.js";
import * as Testing from "../../src/testing/Testing.js";
import { ToolList } from "../support/requests.js";
import { Json } from "../support/sse.js";
import { converse } from "../support/stdio-host.js";

const Ping = Action.make("ping", {
  description: "Answer pong",
  readOnly: true,
  caller: Action.Anyone,
  success: Schema.String,
});

const Secret = Action.make("secret", {
  description: "Answer the secret",
  readOnly: true,
  caller: Action.Anyone,
  success: Schema.String,
});

const app = Action.implement([Ping, Secret], {
  ping: () => Effect.succeed("pong"),
  secret: () => Effect.succeed("hidden"),
});

const Native = Toolkit.make(Tool.make("native", { success: Schema.String }));

const nativeToolkit = McpServer.toolkit(Native).pipe(
  Layer.provide(Native.toLayer({ native: () => Effect.succeed("native") }))
);

const options = { name: "middleware", version: "0" };

const replyTo = (method: string, params: Params = {}) =>
  Effect.flatMap(HttpClient.execute(ActionMcp.request(method, params)), (r) =>
    Effect.flatMap(r.text, Schema.decodeEffect(Json))
  );

const recordingMiddleware = () => {
  const seen: string[] = [];

  const recording = McpServer.middleware((effect, { method, target }) =>
    Effect.suspend(() => {
      seen.push(`${method} ${target}`);

      return effect;
    })
  );

  return { seen, recording };
};

describe.each([
  { transport: "long-lived", requestScoped: false },
  { transport: "request-scoped", requestScoped: true },
])("native MCP middleware on an endpoint, $transport", ({ requestScoped }) => {
  it.effect.each([
    {
      where: "provided around the endpoint",
      seenFor: ["tools/call ping", "tools/call native"],
    },
    { where: "merged into features", seenFor: ["tools/call ping"] },
  ])(
    "runs a McpServer.middleware $where for an action tool's call, and for a native tool's only around the endpoint",
    ({ where, seenFor }) =>
      Effect.gen(function* () {
        const { seen, recording } = recordingMiddleware();

        const endpoint =
          where === "merged into features"
            ? ActionMcp.layerHttp(app, {
                ...options,
                requestScoped,
                features: Layer.merge(recording.layer, nativeToolkit),
              })
            : ActionMcp.layerHttp(app, {
                ...options,
                requestScoped,
                features: nativeToolkit,
              }).pipe(Layer.provide(recording.layer));

        const replies = yield* Effect.forEach(["ping", "native"], (name) =>
          replyTo("tools/call", { name, arguments: {} })
        ).pipe(Effect.provide(Testing.layer(endpoint)));

        expect(replies).toMatchObject([
          { result: { structuredContent: "pong" } },
          { result: { isError: false } },
        ]);
        expect(seen).toStrictEqual(seenFor);
      })
  );

  it.effect(
    "hides an action tool with a McpServer.visibility provided around the endpoint: tools/list leaves it out, and its call answers as an unknown tool's",
    () =>
      Effect.gen(function* () {
        const hidingSecret = McpServer.visibility(({ target }) =>
          Effect.succeed(target !== Secret.name)
        );

        const endpoint = ActionMcp.layerHttp(app, {
          ...options,
          requestScoped,
        }).pipe(Layer.provide(hidingSecret.layer));

        const [listed, hidden, unknown] = yield* Effect.all([
          replyTo("tools/list"),
          replyTo("tools/call", { name: "secret", arguments: {} }),
          replyTo("tools/call", { name: "missing", arguments: {} }),
        ]).pipe(Effect.provide(Testing.layer(endpoint)));

        const { result } = yield* Schema.decodeUnknownEffect(ToolList)(listed);

        expect(result.tools.map(({ name }) => name)).toStrictEqual(["ping"]);
        expect(unknown).toMatchObject({ error: { code: -32_602 } });
        expect(JSON.stringify(hidden)).toBe(
          JSON.stringify(unknown).replace("missing", "secret")
        );
      })
  );
});

it.effect(
  "runs a McpServer.middleware provided around runStdio for an action tool's call",
  () =>
    Effect.gen(function* () {
      const { seen, recording } = recordingMiddleware();

      const [called = ""] = yield* converse(
        ActionMcp.runStdio(app, options).pipe(Effect.provide(recording.layer)),
        "2026-07-28",
        [{ method: "tools/call", params: { name: "ping", arguments: {} } }]
      );

      expect(JSON.parse(called)).toMatchObject({
        result: { structuredContent: "pong" },
      });
      expect(seen).toStrictEqual(["tools/call ping"]);
    })
);
