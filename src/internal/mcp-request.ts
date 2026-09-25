import { Predicate } from "effect";

/** Where an MCP request is sent: `path` against `baseUrl`. */
export interface McpEndpoint {
  /** Defaults to `/mcp`, the default `ActionMcp.layerHttp` path. */
  readonly path?: string;
  /** Defaults to `http://localhost`. */
  readonly baseUrl?: string | URL;
}

/** A stateless 2026-07-28 request. */
export interface McpRequestOptions extends McpEndpoint {
  readonly method: string;
  readonly params?: McpRequestParams;
  readonly headers?: ConstructorParameters<typeof Headers>[0];
}

/**
 * What `JSON.stringify` accepts, not only valid JSON: `undefined` fields are
 * dropped, and tests send malformed arguments on purpose.
 */
export type McpRequestValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<McpRequestValue>
  | { readonly [key: string]: McpRequestValue };

/** JSON-RPC `params`; `_meta` is merged shallowly over the defaults `mcpRequest` supplies. */
export interface McpRequestParams {
  readonly _meta?: { readonly [key: string]: McpRequestValue };
  readonly [key: string]: McpRequestValue;
}

/** Build one stateless 2026-07-28 JSON-RPC request, with client metadata defaulted. */
export const mcpRequest = ({
  path = "/mcp",
  baseUrl = "http://localhost",
  method,
  params = {},
  headers: init,
}: McpRequestOptions): Request => {
  const headers = new Headers(init);
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json, text/event-stream");
  headers.set("mcp-protocol-version", "2026-07-28");
  headers.set("mcp-method", method);

  if (Predicate.isString(params.name)) headers.set("mcp-name", params.name);

  return new Request(new URL(path, baseUrl), {
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
