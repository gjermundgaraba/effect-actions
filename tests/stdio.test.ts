import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vite-plus/test";

/** A client of the stdio example in a real subprocess, speaking only `revision`. */
const connect = async (revision: string) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "examples/mcp-stdio.ts"],
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
  it.each(["2026-07-28", "2025-11-25", "2025-06-18"])(
    "serves list/call to a %s host and keeps logs off protocol stdout",
    async (revision) => {
      const { client, output, connected } = await connect(revision);

      try {
        await connected;
        expect(client.getNegotiatedProtocolVersion()).toBe(revision);
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["status"]);
        expect(await client.callTool({ name: "status", arguments: {} })).toMatchObject({
          isError: false,
          structuredContent: { value: { ready: true } },
        });

        // Invalid arguments are a tool error from 2025-11-25 on, and a protocol error before.
        const invalid = client.callTool({ name: "status", arguments: { invented: true } });
        const message = "Invalid parameters for tool 'status'";

        if (revision === "2025-06-18") {
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

  it("exits cleanly when the host closes stdin", () => {
    const run = spawnSync(process.execPath, ["--import", "tsx", "examples/mcp-stdio.ts"], {
      cwd: process.cwd(),
      input: "",
    });

    expect(run.status).toBe(0);
  }, 30_000);

  it("refuses a host older than 2025-06-18, whose results have no structured content", async () => {
    const { client, connected } = await connect("2025-03-26");

    try {
      // The server counter-offers its newest stateful revision, which the client does not speak.
      await expect(connected).rejects.toThrow("2025-11-25");
    } finally {
      await client.close();
    }
  }, 30_000);
});
