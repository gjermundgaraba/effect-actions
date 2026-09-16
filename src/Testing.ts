/** A stateless 2026-07-28 request. */
export interface McpRequestOptions {
  readonly url: string | URL;
  readonly headers?: ConstructorParameters<typeof Headers>[0];
}

export const mcpRequest = (
  method: string,
  params: Record<string, unknown> & { readonly _meta?: Record<string, unknown> } = {},
  options: McpRequestOptions,
): Request => {
  const headers = new Headers(options.headers);
  for (const [name, value] of Object.entries({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
    ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
  }))
    headers.set(name, value);
  return new Request(options.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
          ...params._meta,
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        },
      },
    }),
  });
};
