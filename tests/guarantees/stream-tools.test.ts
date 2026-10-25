import { expect, it } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Action from "../../src/contract/Action.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as Testing from "../../src/testing/Testing.js";
import * as ActionToolkit from "../../src/toolkit/ActionToolkit.js";

const read = { readOnly: true, caller: Action.Anyone } as const;

const Tail = Action.make("tail", {
  ...read,
  description: "Follow a log.",
  success: Action.Stream(Schema.String),
});

const Follow = Action.make("follow", {
  ...read,
  description: "Follow a build.",
  success: Action.Stream({ line: Schema.String }),
  progress: { step: Schema.Finite },
});

const Ping = Action.make("ping", { ...read, description: "Ping." });

const held = Action.implement([Tail, Follow, Ping], {
  tail: () => Stream.empty,
  follow: () => Stream.empty,
  ping: () => Effect.void,
});

const options = { name: "streams", version: "0" };

const Listed = Schema.Struct({
  result: Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
});

it.effect("leaves an action answering a stream out of a tool surface given it whole", () =>
  Effect.gen(function* () {
    const listed = yield* Effect.flatMap(
      HttpClient.execute(ActionMcp.request("tools/list")),
      HttpClientResponse.schemaBodyJson(Listed),
    );

    const mcp = yield* ActionMcp.client([Tail, Follow, Ping]);

    // @ts-expect-error -- an action answering a stream has no method
    expect(mcp.tail).toBeUndefined();

    expect({
      endpoint: listed.result.tools.map(({ name }) => name),
      client: Object.keys(mcp),
      toolkit: Object.keys(ActionToolkit.make(held).toolkit.tools),
    }).toEqual({ endpoint: ["ping"], client: ["ping"], toolkit: ["ping"] });
    expect(() => ActionMcp.runStdio(held, options)).not.toThrow();
  }).pipe(Effect.provide(Testing.layer(ActionMcp.layerHttp(held, options)))),
);

it("refuses an action answering a stream where a tool surface's actions list it, naming it", () => {
  const message =
    "A tool cannot answer a stream: tail (serve such an action over HTTP, RPC or a " +
    "command, and remove it from actions)";

  expect(() => ActionMcp.layerHttp(held, { ...options, actions: [Tail, Ping] })).toThrow(message);
  expect(() => ActionMcp.runStdio(held, { ...options, actions: [Tail, Ping] })).toThrow(message);
  expect(() => ActionToolkit.make(held, { actions: [Tail, Ping] })).toThrow(message);
});
