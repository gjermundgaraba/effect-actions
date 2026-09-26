import { Predicate } from "effect";

/** A stateless 2026-07-28 request. */
export interface McpMessageOptions {
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

/** JSON-RPC `params`; `_meta` is merged shallowly over the defaults `mcpMessage` supplies. */
export interface McpRequestParams {
  readonly _meta?: { readonly [key: string]: McpRequestValue };
  readonly [key: string]: McpRequestValue;
}

/** An MCP request's headers and JSON-RPC body. */
interface McpMessage {
  readonly headers: Headers;
  readonly body: string;
}

/** One stateless 2026-07-28 JSON-RPC message: its headers and body, client metadata defaulted. */
export const mcpMessage = ({
  method,
  params = {},
  headers: init,
}: McpMessageOptions): McpMessage => {
  const headers = new Headers(init);
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json, text/event-stream");
  headers.set("mcp-protocol-version", "2026-07-28");
  headers.set("mcp-method", method);

  if (Predicate.isString(params.name)) headers.set("mcp-name", params.name);

  const body = JSON.stringify({
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
  });

  return { headers, body };
};
