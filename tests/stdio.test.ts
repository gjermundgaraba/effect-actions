import { spawnSync } from "node:child_process";
import { format } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Console, Effect, Stdio } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vite-plus/test";
import * as Action from "../src/Action.js";
import * as ActionMcp from "../src/ActionMcp.js";
import { everyConsoleMethod } from "./console-methods.js";

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
  it.each(["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"])(
    "serves list/call to a %s host and keeps logs off protocol stdout",
    async (revision) => {
      const { client, output, connected } = await connect(revision);

      try {
        await connected;
        expect(client.getNegotiatedProtocolVersion()).toBe(revision);
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["status"]);
        const called = await client.callTool({ name: "status", arguments: {} });
        const [text] = called.content.map((part) => (part.type === "text" ? part.text : ""));

        // Every revision reads the same `{ value }` text; 2025-06-18 on also structures it.
        expect(called.isError).toBe(false);
        expect(JSON.parse(text ?? "")).toEqual({ value: { ready: true } });
        expect(called.structuredContent).toEqual(
          revision >= "2025-06-18" ? { value: { ready: true } } : undefined,
        );

        // Invalid arguments are a tool error from 2025-11-25 on, and a protocol error before.
        const invalid = client.callTool({ name: "status", arguments: { invented: true } });
        const message = "Invalid parameters for tool 'status'";

        if (revision < "2025-11-25") {
          await expect(invalid).rejects.toThrow(message);
        } else {
          const result = await invalid;
          const texts = result.content.map((part) => (part.type === "text" ? part.text : ""));

          expect(result.isError).toBe(true);
          expect(texts.join("\n")).toContain(message);
        }
      } finally {
        await client.close();
      }

      expect(output.stderr).toContain("status called");
    },
    30_000,
  );

  it("sends every console logger's output and Console.log to stderr", async () => {
    const { client, output, connected } = await connect("2026-07-28", "tests/stdio-console.ts");

    try {
      await connected;

      const result = await client.callTool({ name: "status", arguments: {} });
      expect(result.isError).not.toBe(true);
    } finally {
      await client.close();
    }

    expect(output.stderr).toContain('"message":"json logger"');
    expect(output.stderr).toContain("console log");
  }, 30_000);

  // Node's console prints counters, timers, group labels, tables and directories on stdout.
  it("sends every console method to stderr, counting, timing and indenting, and nothing to stdout", () => {
    const run = spawnSync(process.execPath, ["--import", "tsx", "tests/stdio-console.ts"], {
      cwd: process.cwd(),
      input: "",
    });

    const stderr = run.stderr.toString();
    const lines = (...printed: ReadonlyArray<string>) => printed.join("\n");

    expect(run.status).toBe(0);
    expect(run.stdout.toString()).toBe("");
    expect(stderr).toContain(lines("log", "info", "debug", "warn", "error", "dirxml"));
    expect(stderr).toContain(lines("{ dir: true }", "[ { table: 1 } ]"));
    expect(stderr).toContain(lines("default: 1", "default: 2", "calls: 1", "calls: 1"));
    expect(stderr).toMatch(/\ntimer: [\d.]+m?s logged\ntimer: [\d.]+m?s\n/);
    expect(stderr).toContain(
      lines(
        "group",
        "  inside",
        "  collapsed",
        "    deeper",
        "    second line",
        "    { nested: true }",
      ),
    );
    expect(stderr).toContain(lines("  unlabeled", ""));
  }, 30_000);

  it("exits cleanly when the host closes stdin", () => {
    const run = spawnSync(process.execPath, ["--import", "tsx", "examples/mcp-stdio.ts"], {
      cwd: process.cwd(),
      input: "",
    });

    expect(run.status).toBe(0);
  }, 30_000);
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
  it("writes every method through the host console's error, as Node's console prints them", async () => {
    const host = recording();
    const Status = Action.make("status", { description: "Report", access: "read" });

    // The builder runs when the server starts; a host with nothing on stdin then closes it.
    const status = Action.implement(
      Status,
      Effect.as(everyConsoleMethod(TestClock.adjust), () => Effect.void),
    );

    await Effect.runPromise(
      ActionMcp.runStdio(status, { name: "console", version: "0" }).pipe(
        Effect.provideService(Console.Console, host.console),
        Effect.provide(Stdio.layerTest({})),
        Effect.provide(TestClock.layer()),
      ),
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
      "Warning: Count for 'missing' does not exist",
      "Warning: Label 'timer' already exists for console.time()",
      "timer: 250ms logged",
      "timer: 1.500s",
      "Warning: No such label 'timer' for console.timeEnd()",
      "Warning: No such label 'timer' for console.timeLog()",
      "group",
      "  inside",
      "  collapsed",
      "    deeper\n    second line",
      "    { nested: true }",
      // A value the console inspects is printed as it is, only its first line indented.
      "    'dir\\nvalue'",
      // Effect's unlabeled group, which Node would label `undefined`.
      "  unlabeled",
      "scoped: 250ms",
      "after",
    ]);
  });
});
