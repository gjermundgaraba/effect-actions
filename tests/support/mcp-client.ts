import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

interface McpClientOptions {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly path?: string;
  readonly negotiation?: "legacy" | "auto";
}

const statelessRevision = "2026-07-28";

export const withMcpClient = async <A>(
  { fetch, path = "/mcp", negotiation }: McpClientOptions,
  run: (client: Client) => Promise<A>
): Promise<A> => {
  const client = new Client(
    { name: "test", version: "0" },
    { versionNegotiation: { mode: negotiation ?? { pin: statelessRevision } } }
  );

  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(path, "http://localhost"), {
        fetch: async (input, init) => await fetch(new Request(input, init)),
      })
    );

    return await run(client);
  } finally {
    await client.close();
  }
};
