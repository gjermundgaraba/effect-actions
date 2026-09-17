import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export interface McpClientOptions {
  /** A web handler, such as `HttpRouter.toWebHandler(routes).handler`. */
  readonly fetch: (request: Request) => Promise<Response>;
  readonly path: string;
  readonly mode?: "legacy" | "modern";
  readonly baseUrl?: string | URL;
  readonly headers?: ConstructorParameters<typeof Headers>[0];
}

/** Connect an official client and always close its transport after the callback. */
export const withMcpClient = async <A>(
  { fetch, mode = "modern", path, baseUrl = "http://localhost", headers }: McpClientOptions,
  run: (client: Client) => Promise<A>,
): Promise<A> => {
  const client = new Client(
    { name: "test", version: "0" },
    { versionNegotiation: { mode: mode === "modern" ? { pin: "2026-07-28" } : "legacy" } },
  );

  try {
    const transportOptions: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = {
      fetch: (input, init) => fetch(new Request(input, init)),
    };

    if (headers !== undefined) transportOptions.requestInit = { headers };

    await client.connect(
      new StreamableHTTPClientTransport(new URL(path, baseUrl), transportOptions),
    );

    return await run(client);
  } finally {
    await client.close();
  }
};
