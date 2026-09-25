import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vite-plus/test";

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
});
