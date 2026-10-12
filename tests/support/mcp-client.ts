import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

interface McpClientOptions {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly path?: string;
}

const servedRevision = "2026-07-28";

export const withMcpClient = async <A>(
  { fetch, path = "/mcp" }: McpClientOptions,
  run: (client: Client) => Promise<A>,
): Promise<A> => {
  const client = new Client(
    { name: "test", version: "0" },
    { versionNegotiation: { mode: { pin: servedRevision } } },
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
