import { Predicate, type Schema } from "effect";

/** A stateless 2026-07-28 request. */
export interface McpRequestOptions {
  readonly url: string | URL;
  readonly headers?: ConstructorParameters<typeof Headers>[0];
}

export interface McpRequestParams {
  readonly _meta?: Schema.JsonObject;
  readonly [key: string]: Schema.Json | undefined;
}

export const mcpRequest = (
  method: string,
  params: McpRequestParams = {},
  options: McpRequestOptions,
): Request => {
  const headers = new Headers(options.headers);
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json, text/event-stream");
  headers.set("mcp-protocol-version", "2026-07-28");
  headers.set("mcp-method", method);

  if (Predicate.isString(params.name)) headers.set("mcp-name", params.name);

  return new Request(options.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: Object.assign(
          {
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
          },
          params._meta,
          { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
        ),
      },
    }),
  });
};
