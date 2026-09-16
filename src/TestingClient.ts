import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export interface McpClientOptions {
  readonly mode?: "legacy" | "modern";
  readonly path?: string;
  readonly baseUrl?: string | URL;
  readonly headers?: ConstructorParameters<typeof Headers>[0];
}

/** Connect an official client and always close its transport after the callback. */
export const withMcpClient = async <A>(
  fetch: (request: Request) => Promise<Response>,
  run: (client: Client) => Promise<A>,
  { mode = "modern", path = "/mcp", baseUrl = "http://localhost", headers }: McpClientOptions = {},
): Promise<A> => {
  const client = new Client(
    { name: "test", version: "0" },
    { versionNegotiation: { mode: mode === "modern" ? { pin: "2026-07-28" } : "legacy" } },
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(path, baseUrl), {
        ...(headers === undefined ? {} : { requestInit: { headers } }),
        fetch: (input, init) => fetch(new Request(input, init)),
      }),
    );
    return await run(client);
  } finally {
    await client.close();
  }
};
