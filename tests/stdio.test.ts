import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vite-plus/test";
import { Effect, Layer, Schema, Stdio } from "effect";
import * as Action from "../src/Action.js";
import * as ActionGroup from "../src/ActionGroup.js";
import * as ActionMcp from "../src/ActionMcp.js";

describe("MCP stdio example", () => {
  it("serves list/call over a real subprocess and keeps logs off protocol stdout", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "examples/mcp-stdio.ts"],
      cwd: process.cwd(),
      stderr: "pipe",
    });

    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const client = new Client(
      { name: "stdio-test", version: "0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );

    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["status"]);
      expect(await client.callTool({ name: "status", arguments: {} })).toMatchObject({
        isError: false,
        structuredContent: { value: { ready: true } },
      });
      expect(
        await client.callTool({ name: "status", arguments: { invented: true } }),
      ).toMatchObject({
        isError: true,
      });
    } finally {
      await client.close();
    }

    expect(stderr).toContain("status called");
  });

  it("does not acquire tool-empty groups and acquires a multi-tool group once", async () => {
    let emptyBuilds = 0;
    let toolBuilds = 0;

    const Hidden = Action.make("hidden", {
      description: "Hidden",
      access: "write",
      success: Schema.String,
      mcp: false,
    });

    const One = Action.make("one", { description: "One", access: "write", success: Schema.Number });
    const Two = Action.make("two", { description: "Two", access: "write", success: Schema.Number });

    const empty = ActionGroup.make({ name: "empty" }, Hidden).implement(
      Effect.sync(() => {
        emptyBuilds++;

        return { hidden: () => Effect.succeed("hidden") };
      }),
    );

    const tools = ActionGroup.make({ name: "tools" }, One, Two).implement(
      Effect.sync(() => {
        toolBuilds++;

        return { one: () => Effect.succeed(1), two: () => Effect.succeed(2) };
      }),
    );

    const layer = ActionMcp.layerStdio([empty, tools], {
      name: "test",
      version: "0",
    }).pipe(Layer.provide(Stdio.layerTest({})));

    await Effect.runPromise(Effect.scoped(Layer.build(layer)));

    expect(emptyBuilds).toBe(0);
    expect(toolBuilds).toBe(1);

    const duplicate = ActionGroup.make(
      { name: "duplicate" },
      Action.make("other", {
        description: "Other",
        access: "write",
        success: Schema.Number,
        mcp: { name: "one" },
      }),
    ).implement({ other: () => Effect.succeed(1) });

    expect(() =>
      ActionMcp.layerStdio([tools, duplicate], {
        name: "duplicate",
        version: "0",
      }),
    ).toThrow("Duplicate MCP tool: one");
  });
});
