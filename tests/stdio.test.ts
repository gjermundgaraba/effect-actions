import { spawn } from "node:child_process";
import { once } from "node:events";
import { format } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Console, Deferred, Effect, Predicate, Schema, Sink, Stdio, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it, onTestFinished } from "@effect/vitest";
import * as Action from "../src/Action.js";
import * as ActionMcp from "../src/ActionMcp.js";
import { statelessRequest } from "../src/internal/mcp.js";
import { everyConsoleMethod } from "./console-methods.js";
import { rawToolCall } from "./requests.js";
import { serve } from "./serve.js";
import { converse } from "./stdio-host.js";

/** A client of a stdio server in a real subprocess, speaking only `revision`. */
const connect = async (revision: string, script = "examples/mcp-stdio.ts") => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", script],
    cwd: process.cwd(),
    stderr: "pipe",
  });

  const output = { stderr: "" };
  transport.stderr?.on("data", (chunk: Buffer) => {
    output.stderr += chunk.toString();
  });

  // A 2026 revision is pinned; a 2025 one is the only revision the legacy handshake offers.
  const client = new Client(
    { name: "stdio-test", version: "0" },
    revision.startsWith("2026")
      ? { versionNegotiation: { mode: { pin: revision } } }
      : { supportedProtocolVersions: [revision] },
  );

  return { client, output, connected: client.connect(transport) };
};

// A real subprocess compiles TypeScript at startup, which can outlast the default timeout
// under load.
describe("MCP stdio example", () => {
  // The current revision, and the legacy handshake of the revisions before it.
  it.each(["2026-07-28", "2025-11-25"])(
    "serves list/call to a %s host and keeps logs off protocol stdout",
    async (revision) => {
      const { client, output, connected } = await connect(revision);

      try {
        await connected;
        expect(client.getNegotiatedProtocolVersion()).toBe(revision);
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["status"]);
        const called = await client.callTool({ name: "status", arguments: {} });
        const [text] = called.content.map((part) => (part.type === "text" ? part.text : ""));

        expect(called.isError).toBe(false);
        expect(JSON.parse(text ?? "")).toEqual({ ready: true });
        expect(called.structuredContent).toEqual({ ready: true });
      } finally {
        await client.close();
      }

      expect(output.stderr).toContain("status called");
    },
    30_000,
  );

  // Node's console prints counters, timers, group labels, tables and directories on stdout.
  it("writes every console method and logger to stderr, and only the answer to stdout", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "tests/stdio-console.ts"], {
      cwd: process.cwd(),
    });

    // A server that never exits ends with its test.
    onTestFinished(() => void child.kill());

    const output = { stdout: "", stderr: "" };

    child.stdout.on("data", (chunk: Buffer) => {
      output.stdout += chunk.toString();

      // The call is answered: closing stdin ends the server.
      if (output.stdout.includes("\n") && !child.stdin.writableEnded) {
        child.stdin.end();
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      output.stderr += chunk.toString();
    });

    // Its exit code and signal; a process that fails to start rejects instead.
    const exited = once(child, "close");
    const call = statelessRequest("tools/call", { name: "status", arguments: {} }).body;

    child.stdin.write(`${JSON.stringify(call)}\n`);
    expect(await exited).toEqual([0, null]);

    const [answer = "", ...after] = output.stdout.split("\n");
    const lines = (...printed: ReadonlyArray<string>) => printed.join("\n");

    expect(after).toEqual([""]);
    expect(JSON.parse(answer)).toMatchObject({ id: 1, result: { isError: false } });
    expect(output.stderr).toContain('"message":"json logger"');
    expect(output.stderr).toContain("console log");
    expect(output.stderr).toContain(lines("log", "info", "debug", "warn", "error", "dirxml"));
    expect(output.stderr).toContain(lines("{ dir: true }", "[ { table: 1 } ]"));
    expect(output.stderr).toContain(lines("default: 1", "default: 2", "calls: 1", "calls: 1"));
    expect(output.stderr).toMatch(
      /\ntimer %s: \d+(\.\d{1,3})?ms logged\ntimer %s: \d+(\.\d{1,3})?ms\n/,
    );
    expect(output.stderr).toContain(
      lines("group", "inside", "collapsed", "deeper", "second line", "{ nested: true }"),
    );
    // Effect's unlabeled group, which Node would label `undefined`.
    expect(output.stderr).toContain(lines("'dir\\nvalue'", "unlabeled", ""));
  }, 30_000);
});

describe("runStdio's invalid arguments", () => {
  const Ping = Action.make("ping", { description: "Answer", access: "read" });
  const ping = Action.implement(Ping, () => Effect.void, Action.allowAll);

  const Answered = Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({
        result: Schema.Struct({
          isError: Schema.Literal(true),
          content: Schema.Array(Schema.Struct({ text: Schema.String })),
        }),
      }),
      Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }),
    ]),
  );

  // A tool error from 2025-11-25 on, and a protocol error before.
  it.effect.each([
    ["2026-07-28", "result"],
    ["2025-11-25", "result"],
    ["2025-06-18", "error"],
    ["2025-03-26", "error"],
    ["2024-11-05", "error"],
  ] as const)("refuses them to a %s host as its %s", ([revision, kind]) =>
    Effect.gen(function* () {
      const [line] = yield* converse(
        ActionMcp.runStdio(ping, { name: "ping", version: "0" }),
        revision,
        [{ method: "tools/call", params: { name: "ping", arguments: { invented: true } } }],
      );

      const answered = Schema.decodeUnknownSync(Answered)(line);

      const message =
        "result" in answered
          ? answered.result.content.map(({ text }) => text).join("\n")
          : answered.error.message;

      expect(Object.keys(answered)).toEqual([kind]);
      expect(message).toContain("Invalid parameters for tool 'ping'");
    }),
  );
});

describe("runStdio's successes", () => {
  const read = { description: "Succeeds with one kind of JSON value", access: "read" } as const;

  const Ready = Action.make("ready", { ...read, success: { ready: Schema.Boolean } });
  const Count = Action.make("count", { ...read, success: Schema.Finite });
  const Greeting = Action.make("greeting", { ...read, success: Schema.String });
  const List = Action.make("list", { ...read, success: Schema.Array(Schema.Finite) });
  const Reset = Action.make("reset", read);

  const shapes = Action.implement(
    [Ready, Count, Greeting, List, Reset],
    {
      ready: () => Effect.succeed({ ready: true }),
      count: () => Effect.succeed(42),
      greeting: () => Effect.succeed('say "hi"'),
      list: () => Effect.succeed([1, 2]),
      reset: () => Effect.void,
    },
    Action.allowAll,
  );

  // Each tool's encoded success: an object, a number, a string, an array and `null`.
  const successes = [
    ["ready", { ready: true }],
    ["count", 42],
    ["greeting", 'say "hi"'],
    ["list", [1, 2]],
    ["reset", null],
  ] as const;

  const Listed = Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({
        tools: Schema.Array(
          Schema.Struct({ name: Schema.String, outputSchema: Schema.optionalKey(Schema.Json) }),
        ),
      }),
    }),
  );

  const Called = Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({
        isError: Schema.Boolean,
        structuredContent: Schema.optionalKey(Schema.Json),
        content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
      }),
    }),
  );

  // The tools whose success a revision structures, and lists an output schema for: every
  // one on 2026-07-28; only the object on the 2025 revisions with structured content; none
  // before them.
  it.effect.each([
    ["2026-07-28", ["ready", "count", "greeting", "list", "reset"]],
    ["2025-11-25", ["ready"]],
    ["2025-06-18", ["ready"]],
    ["2025-03-26", []],
    ["2024-11-05", []],
  ] as const)("sends each success as it is to a %s host", ([revision, structured]) =>
    Effect.gen(function* () {
      const [listed, ...called] = yield* converse(
        ActionMcp.runStdio(shapes, { name: "shapes", version: "0" }),
        revision,
        [
          { method: "tools/list" },
          ...successes.map(([name]) => ({ method: "tools/call", params: { name, arguments: {} } })),
        ],
      );

      const { tools } = Schema.decodeUnknownSync(Listed)(listed).result;
      const listing = tools.filter(({ outputSchema }) => outputSchema !== undefined);

      expect(listing.map(({ name }) => name)).toEqual(structured);

      for (const [index, [name, success]] of successes.entries()) {
        const { result } = Schema.decodeUnknownSync(Called)(called[index]);
        const isStructured = structured.some((tool) => tool === name);

        expect(result.isError).toBe(false);

        if (isStructured) {
          expect(result.structuredContent).toEqual(success);
        } else {
          expect(result).not.toHaveProperty("structuredContent");
        }

        // The text is the success's JSON; a string sent as text alone is the string itself.
        expect(result.content).toEqual([
          {
            type: "text",
            text: !isStructured && Predicate.isString(success) ? success : JSON.stringify(success),
          },
        ]);
      }
    }),
  );

  it("adds serverInfo and resultType to a 2026-07-28 result, over stdio as over HTTP, and neither before", async () => {
    // The server information, as given; `instructions` is not part of it.
    const serverInfo = {
      name: "shapes",
      version: "0",
      description: "Every kind of success",
      websiteUrl: "https://example.com",
      icons: [{ src: "https://example.com/icon.png" }],
    };

    const options = { ...serverInfo, instructions: "Call any tool." };
    const stdio = ActionMcp.runStdio(shapes, options);
    const call = [{ method: "tools/call", params: { name: "ready", arguments: {} } }];
    const [current = ""] = await Effect.runPromise(converse(stdio, "2026-07-28", call));
    const [earlier = ""] = await Effect.runPromise(converse(stdio, "2025-11-25", call));
    const http = await serve(ActionMcp.layerHttp(shapes, options)).handler(rawToolCall("ready"));

    const own = {
      isError: false,
      structuredContent: { ready: true },
      content: [{ type: "text", text: '{"ready":true}' }],
    };

    expect(JSON.parse(current)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
        resultType: "complete",
        ...own,
      },
    });
    expect((await http.text()).trimEnd()).toBe(current);
    expect(JSON.parse(earlier)).toEqual({ jsonrpc: "2.0", id: 1, result: own });
  });
});

it.effect(
  "leaves a line of stdin that is not JSON unanswered, and answers the request after it",
  () =>
    Effect.gen(function* () {
      const Ping = Action.make("ping", {
        description: "Answer pong",
        access: "read",
        success: Schema.String,
      });

      const ping = Action.implement(Ping, () => Effect.succeed("pong"), Action.allowAll);

      const request = {
        ...statelessRequest("tools/call", { name: "ping", arguments: {} }).body,
        id: 1,
      };

      const answered = yield* Deferred.make<void>();
      const decoder = new TextDecoder();
      let output = "";

      // Two lines no JSON parser reads, then a request; stdin closes once a line is answered.
      const stdin = Stream.make("not json\n", "{\n", `${JSON.stringify(request)}\n`).pipe(
        Stream.concat(Stream.fromEffectDrain(Deferred.await(answered))),
        Stream.encodeText,
      );

      const stdout = () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Effect.suspend(() => {
            output += Predicate.isString(chunk) ? chunk : decoder.decode(chunk, { stream: true });

            return output.endsWith("\n") ? Deferred.succeed(answered, undefined) : Effect.void;
          }),
        );

      yield* ActionMcp.runStdio(ping, { name: "ping", version: "0" }).pipe(
        Effect.provide(Stdio.layerTest({ stdin, stdout })),
      );

      // One line, the request's answer: nothing answers the lines before it.
      const lines = output.trimEnd().split("\n");

      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "")).toMatchObject({
        id: 1,
        result: { structuredContent: "pong" },
      });
    }),
);

it.live(
  "interrupts a call when stdin closes, and ends once its uninterruptible work completes",
  () =>
    Effect.gen(function* () {
      const Commit = Action.make("commit", { description: "Commit a write", access: "write" });

      const call = {
        ...statelessRequest("tools/call", { name: "commit", arguments: {} }).body,
        id: 1,
      };

      const started = yield* Deferred.make<void>();
      const decoder = new TextDecoder();
      let committed = false;
      let written = "";

      // Still running when stdin closes, which it does once the call has started.
      const commit = Action.implement(
        Commit,
        () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.sleep(100)),
            Effect.andThen(Effect.sync(() => (committed = true))),
            Effect.uninterruptible,
          ),
        Action.allowAll,
      );

      const stdin = Stream.make(`${JSON.stringify(call)}\n`).pipe(
        Stream.concat(Stream.fromEffectDrain(Deferred.await(started))),
        Stream.encodeText,
      );

      const stdout = () =>
        Sink.forEach((chunk: string | Uint8Array) =>
          Effect.sync(() => (written += Predicate.isString(chunk) ? chunk : decoder.decode(chunk))),
        );

      yield* ActionMcp.runStdio(commit, { name: "commit", version: "0" }).pipe(
        Effect.provide(Stdio.layerTest({ stdin, stdout })),
      );

      // As `runStdio` ends.
      expect(committed).toBe(true);
      // No result for the call: no answer, or a JSON-RPC error.
      expect(written).not.toContain('"result"');
    }),
);

describe("runStdio's input schemas", () => {
  const Item = Schema.Struct({ id: Schema.String }).annotate({ identifier: "Item" });

  const Put = Action.make("put", {
    description: "Store an item",
    access: "write",
    input: { item: Item },
  });

  const put = Action.implement(Put, () => Effect.void, Action.allowAll);

  const Listed = Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({
        tools: Schema.Array(Schema.Struct({ inputSchema: Schema.JsonObject })),
      }),
    }),
  );

  const open = {
    type: "object",
    properties: { item: { $ref: "#/$defs/Item" } },
    required: ["item"],
  };

  const closed = {
    ...open,
    additionalProperties: false,
    $defs: {
      Item: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  };

  // Closed, with the definitions its references name, from 2025-06-18 on. Effect's adapters for
  // the revisions before list only the root's type, properties and required: open, and with a
  // reference that resolves nowhere.
  it.effect.each([
    ["2026-07-28", closed],
    ["2025-11-25", closed],
    ["2025-06-18", closed],
    ["2025-03-26", open],
    ["2024-11-05", open],
  ] as const)("lists the input schema to a %s host", ([revision, schema]) =>
    Effect.gen(function* () {
      const [listed] = yield* converse(
        ActionMcp.runStdio(put, { name: "items", version: "0" }),
        revision,
        [{ method: "tools/list" }],
      );

      const { tools } = Schema.decodeUnknownSync(Listed)(listed).result;

      expect(tools.map(({ inputSchema }) => inputSchema)).toEqual([schema]);
    }),
  );
});

/** A host console recording every call, by method. */
const recording = () => {
  const calls: Array<{ readonly method: string; readonly args: ReadonlyArray<unknown> }> = [];

  const record =
    (method: string) =>
    (...args: ReadonlyArray<unknown>) => {
      calls.push({ method, args });
    };

  const console: Console.Console = {
    assert: record("assert"),
    clear: record("clear"),
    count: record("count"),
    countReset: record("countReset"),
    debug: record("debug"),
    dir: record("dir"),
    dirxml: record("dirxml"),
    error: record("error"),
    group: record("group"),
    groupCollapsed: record("groupCollapsed"),
    groupEnd: record("groupEnd"),
    info: record("info"),
    log: record("log"),
    table: record("table"),
    time: record("time"),
    timeEnd: record("timeEnd"),
    timeLog: record("timeLog"),
    trace: record("trace"),
    warn: record("warn"),
  };

  return { calls, console };
};

describe("runStdio's console", () => {
  it.effect("writes every method through the host console's error", () =>
    Effect.gen(function* () {
      const host = recording();
      const Status = Action.make("status", { description: "Report", access: "read" });

      // The builder runs when the server starts; a host with nothing on stdin then closes it.
      const status = Action.implement(
        Status,
        Effect.as(everyConsoleMethod(TestClock.adjust), () => Effect.void),
        Action.allowAll,
      );

      yield* ActionMcp.runStdio(status, { name: "console", version: "0" }).pipe(
        Effect.provideService(Console.Console, host.console),
        Effect.provide(Stdio.layerTest({})),
      );

      expect(host.calls.filter(({ method }) => method !== "error")).toEqual([]);
      expect(host.calls.map(({ args }) => format(...args))).toEqual([
        "log",
        "info",
        "debug",
        "warn",
        "error",
        "dirxml",
        "{ dir: true }",
        "[ { table: 1 } ]",
        "Assertion failed: assert failed",
        "Trace: trace",
        // From the caller's frame on, as Node's own trace.
        expect.stringMatching(/^ {4}at .*console-methods\.ts/),
        "default: 1",
        "default: 2",
        "calls: 1",
        "calls: 1",
        // A timer started again restarts; one ended prints nothing more.
        "timer %s: 250ms logged",
        "timer %s: 1500ms",
        // A group prints its label, and indents nothing.
        "group",
        "inside",
        "collapsed",
        "deeper\nsecond line",
        "{ nested: true }",
        "'dir\\nvalue'",
        // Effect's unlabeled group, which Node would label `undefined`.
        "unlabeled",
        "scoped: 250ms",
        "after",
      ]);
    }),
  );
});
