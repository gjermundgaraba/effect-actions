import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vite-plus/test";

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

  it("exits cleanly when the host closes stdin", () => {
    const run = spawnSync(process.execPath, ["--import", "tsx", "examples/mcp-stdio.ts"], {
      cwd: process.cwd(),
      input: "",
    });

    expect(run.status).toBe(0);
  }, 30_000);
});
