import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Schema } from "effect";
import * as Action from "../../src/contract/Action.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as Testing from "../../src/testing/Testing.js";
import { initializeParams, mcpRequest, send, sessionRequest } from "../support/requests.js";
import { exchange } from "../support/stdio-host.js";

const Import = Action.make("importAll", {
  description: "Import every item, reporting how many are done.",
  input: { count: Schema.Finite },
  success: { imported: Schema.Finite },
  progress: { done: Schema.Finite },
  readOnly: false,
  caller: Action.Anyone,
});

const imports = Action.implement(Import, ({ count }, { progress }) =>
  Effect.as(
    Effect.forEach(
      Array.from({ length: count }, (_, index) => index + 1),
      (done) => progress({ done }),
    ),
    { imported: count },
  ),
);

const served = Testing.layer(ActionMcp.layerHttp(imports, { name: "test", version: "0" }));

const Json = Schema.fromJsonString(Schema.Json);

const Answered = Schema.Struct({ result: Schema.Struct({ structuredContent: Schema.Json }) });

const notified = (progressToken: string | number, done: number) => ({
  jsonrpc: "2.0",
  method: "notifications/progress",
  params: {
    _meta: { "effect-actions/progress": { done } },
    progressToken,
    progress: done,
    message: JSON.stringify({ done }),
  },
});

const framesOf = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => Schema.decodeUnknownSync(Json)(line.slice(6)));

describe("an MCP tool of an action reporting progress", () => {
  it.effect(
    "sends each value as notifications/progress on the request's token, then the result",
    () =>
      Effect.gen(function* () {
        const response = yield* send(
          mcpRequest({
            method: "tools/call",
            params: { name: "importAll", arguments: { count: 2 }, _meta: { progressToken: "t1" } },
          }),
        );

        const text = yield* response.text;

        const frames = framesOf(text);

        expect(frames.slice(0, 2)).toEqual([notified("t1", 1), notified("t1", 2)]);
        expect(Schema.decodeUnknownSync(Answered)(frames[2]).result.structuredContent).toEqual({
          imported: 2,
        });
      }).pipe(Effect.provide(served)),
  );

  it.effect("sends no notifications to a session's call without a token", () =>
    Effect.gen(function* () {
      const { lines } = yield* exchange(
        ActionMcp.runStdio(imports, { name: "test", version: "0" }),
        "2025-11-25",
        [{ method: "tools/call", params: { name: "importAll", arguments: { count: 2 } } }],
      );

      expect(lines.join("\n")).toContain('"imported":2');
      expect(lines.join("\n")).not.toContain("notifications/progress");
    }),
  );
});

describe("an MCP tool of an action reporting progress, in a 2025 session", () => {
  it.effect("sends each call's values on its own token, and none to a call without one", () =>
    Effect.gen(function* () {
      const opened = yield* send(
        sessionRequest({ method: "initialize", params: initializeParams }),
      );

      const session = opened.headers["mcp-session-id"] ?? "";
      const headers = { "mcp-protocol-version": "2025-11-25" };

      yield* send(sessionRequest({ method: "notifications/initialized", session, headers }));

      const call = (token: string | undefined) =>
        Effect.flatMap(
          send(
            sessionRequest({
              method: "tools/call",
              params: {
                name: "importAll",
                arguments: { count: 2 },
                ...(token === undefined ? {} : { _meta: { progressToken: token } }),
              },
              session,
              headers,
            }),
          ),
          (response) => response.text,
        );

      const [tokened, untokened] = yield* Effect.all([call("a"), call(undefined)], {
        concurrency: "unbounded",
      });

      expect(framesOf(tokened).slice(0, 2)).toEqual([notified("a", 1), notified("a", 2)]);
      expect(untokened).toContain('"imported":2');
      expect(untokened).not.toContain("notifications/progress");
    }).pipe(Effect.provide(served)),
  );
});

describe("a stdio tool of an action reporting progress", () => {
  it.effect.each(["2026-07-28", "2025-11-25"] as const)(
    "writes each value as notifications/progress to a %s host before the result",
    (revision) =>
      Effect.gen(function* () {
        const { lines } = yield* exchange(
          ActionMcp.runStdio(imports, { name: "test", version: "0" }),
          revision,
          [
            {
              method: "tools/call",
              params: { name: "importAll", arguments: { count: 2 }, _meta: { progressToken: 7 } },
            },
          ],
        );

        const messages = lines
          .filter((line) => line !== "")
          .map((line) => Schema.decodeUnknownSync(Json)(line));

        const isProgress = (message: Schema.Json) =>
          JSON.stringify(message).includes('"notifications/progress"');

        expect(messages.filter(isProgress)).toEqual([notified(7, 1), notified(7, 2)]);
        expect(messages.findLastIndex(isProgress)).toBeLessThan(
          messages.findIndex((message) => JSON.stringify(message).includes('"imported":2')),
        );
      }),
  );
});

describe("ActionMcp.client's onProgress", () => {
  it.effect("hands on each value, in order, then answers", () =>
    Effect.gen(function* () {
      const mcp = yield* ActionMcp.client([Import]);
      const seen: Array<number> = [];

      const answer = yield* mcp.importAll(
        { count: 3 },
        { onProgress: ({ done }) => Effect.sync(() => seen.push(done)) },
      );

      expect([seen, answer]).toEqual([[1, 2, 3], { imported: 3 }]);
    }).pipe(Effect.provide(served)),
  );

  it.effect("keeps none of the progress frames in the body of a reply it cannot read", () =>
    Effect.gen(function* () {
      const replying = async () =>
        new Response(
          [
            JSON.stringify(notified("progress", 1)),
            JSON.stringify(notified("progress", 2)),
            "not a reply",
          ]
            .map((frame) => `data: ${frame}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );

      const seen: Array<number> = [];

      const failed = yield* Effect.gen(function* () {
        const mcp = yield* ActionMcp.client([Import]);

        return yield* Effect.flip(
          mcp.importAll(
            { count: 2 },
            { onProgress: ({ done }) => Effect.sync(() => seen.push(done)) },
          ),
        );
      }).pipe(Effect.provide(Testing.layer(replying)));

      expect(seen).toEqual([1, 2]);
      expect(failed).toMatchObject({ reason: { _tag: "NoReply", body: "not a reply" } });
    }),
  );

  it.effect("fails naming the frame an event stream sent past the size a client reads", () =>
    Effect.gen(function* () {
      const maxEventSize = 10 * 1024 * 1024;

      const replying = async () =>
        new Response(`data: ${"x".repeat(maxEventSize + 1)}`, {
          headers: { "content-type": "text/event-stream" },
        });

      const failed = yield* Effect.gen(function* () {
        const mcp = yield* ActionMcp.client([Import]);

        return yield* Effect.flip(mcp.importAll({ count: 1 }, { onProgress: () => Effect.void }));
      }).pipe(Effect.provide(Testing.layer(replying)));

      expect(failed).toMatchObject({ reason: { _tag: "FrameTooLarge", maxEventSize } });
    }),
  );

  it.effect("answers alike without onProgress", () =>
    Effect.gen(function* () {
      const mcp = yield* ActionMcp.client([Import]);

      expect(yield* mcp.importAll({ count: 2 })).toEqual({ imported: 2 });
    }).pipe(Effect.provide(served)),
  );

  it.effect("hands on each value as its notification arrives, before the result", () =>
    Effect.gen(function* () {
      const seen = yield* Deferred.make<void>();

      const Wait = Action.make("waitForCaller", {
        description: "Report once, then answer once the caller has seen it.",
        success: { ok: Schema.Boolean },
        progress: { step: Schema.Finite },
        readOnly: false,
        caller: Action.Anyone,
      });

      const waits = Action.implement(Wait, (_input, { progress }) =>
        Effect.as(Effect.andThen(progress({ step: 1 }), Deferred.await(seen)), { ok: true }),
      );

      const answer = yield* Effect.gen(function* () {
        const mcp = yield* ActionMcp.client([Wait]);

        return yield* mcp.waitForCaller(
          {},
          { onProgress: () => Deferred.succeed(seen, undefined) },
        );
      }).pipe(
        Effect.provide(Testing.layer(ActionMcp.layerHttp(waits, { name: "test", version: "0" }))),
      );

      expect(answer).toEqual({ ok: true });
    }),
  );
});
