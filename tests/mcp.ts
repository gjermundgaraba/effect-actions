import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

/** A stateless 2026-07-28 request. */
export const mcpRequest = (method: string, params: Record<string, unknown> = {}): Request =>
  new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
        },
      },
    }),
  });

export const withMcpClient = async <A>(
  fetch: (request: Request) => Promise<Response>,
  run: (client: Client) => Promise<A>,
  { mode = "modern", path = "/mcp" }: { mode?: "legacy" | "modern"; path?: string } = {},
): Promise<A> => {
  const client = new Client(
    { name: "test", version: "0" },
    { versionNegotiation: { mode: mode === "modern" ? { pin: "2026-07-28" } : "legacy" } },
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(path, "http://localhost"), {
        fetch: (input, init) => fetch(new Request(input, init)),
      }),
    );
    return await run(client);
  } finally {
    await client.close();
  }
};
