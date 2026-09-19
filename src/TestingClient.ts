import {
  type ClientOptions,
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

/** How `withMcpClient` connects the official client. */
export interface McpClientOptions {
  /** A web handler, such as `HttpRouter.toWebHandler(routes).handler`. */
  readonly fetch: (request: Request) => Promise<Response>;
  readonly path: string;
  /** Passed directly to the official client; omitted options use its native default. */
  readonly versionNegotiation?: ClientOptions["versionNegotiation"];
  /** Defaults to `http://localhost`. */
  readonly baseUrl?: string | URL;
  readonly headers?: ConstructorParameters<typeof Headers>[0];
}

/** Connect an official client and always close its transport after the callback. */
export const withMcpClient = async <A>(
  { fetch, path, baseUrl = "http://localhost", headers, versionNegotiation }: McpClientOptions,
  run: (client: Client) => Promise<A>,
): Promise<A> => {
  const client = new Client(
    { name: "test", version: "0" },
    versionNegotiation === undefined ? {} : { versionNegotiation },
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
