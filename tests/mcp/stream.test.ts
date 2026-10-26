import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Schema, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Action from "../../src/contract/Action.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as Testing from "../../src/testing/Testing.js";

class LogGone extends Schema.TaggedError<LogGone>()("LogGone", { at: Schema.Finite }) {}

const Tail = Action.make("tail", {
  description: "Follow a log, line by line, reporting how far it is.",
  input: { count: Schema.Finite, gone: Schema.optional(Schema.Boolean) },
  success: Action.Stream({ n: Schema.Finite }),
  progress: { read: Schema.Finite },
  error: LogGone,
  readOnly: true,
  caller: Action.Anyone,
});

const tails = Action.implement(Tail, ({ count, gone }, { progress }) => {
  const lines = Stream.mapEffect(Stream.range(1, count), (n) =>
    Effect.as(progress({ read: n }), { n }),
  );

  return gone === true ? Stream.concat(lines, Stream.fail(new LogGone({ at: count }))) : lines;
});

const served = Testing.layer(ActionMcp.layerHttp(tails, { name: "test", version: "0" }));

const Called = Schema.Struct({
  result: Schema.Struct({ isError: Schema.Boolean, structuredContent: Schema.Json }),
});

const Listed = Schema.Struct({
  result: Schema.Struct({
    tools: Schema.Array(Schema.Struct({ name: Schema.String, outputSchema: Schema.Json })),
  }),
});

describe("an MCP tool of an action answering a stream", () => {
  it.effect("answers its elements collected into one array, an array its listing declares", () =>
    Effect.gen(function* () {
      const called = yield* Effect.flatMap(
        HttpClient.execute(
          ActionMcp.request("tools/call", { name: "tail", arguments: { count: 2 } }),
        ),
        HttpClientResponse.schemaBodyJson(Called),
      );

      const listed = yield* Effect.flatMap(
        HttpClient.execute(ActionMcp.request("tools/list")),
        HttpClientResponse.schemaBodyJson(Listed),
      );

      expect(called.result).toEqual({ isError: false, structuredContent: [{ n: 1 }, { n: 2 }] });
      expect(listed.result.tools).toMatchObject([
        { name: "tail", outputSchema: { type: "array" } },
      ]);
    }).pipe(Effect.provide(served)),
  );

  it.effect(
    "gives ActionMcp.client a stream of the collected elements, progress to onProgress",
    () =>
      Effect.gen(function* () {
        const mcp = yield* ActionMcp.client([Tail]);
        const read: Array<number> = [];

        const elements = yield* Stream.runCollect(
          mcp.tail(
            { count: 3 },
            { onProgress: (value) => Effect.sync(() => read.push(value.read)) },
          ),
        );

        expect([elements, read]).toEqual([
          [{ n: 1 }, { n: 2 }, { n: 3 }],
          [1, 2, 3],
        ]);
      }).pipe(Effect.provide(served)),
  );

  it.effect("answers a stream failing after its elements with the declared failure alone", () =>
    Effect.gen(function* () {
      const mcp = yield* ActionMcp.client([Tail]);
      const seen: Array<number> = [];

      const exit = yield* Effect.exit(
        Stream.runForEach(mcp.tail({ count: 2, gone: true }), ({ n }) =>
          Effect.sync(() => seen.push(n)),
        ),
      );

      expect([seen, exit]).toEqual([[], Exit.fail(new LogGone({ at: 2 }))]);
    }).pipe(Effect.provide(served)),
  );
});
