import { Predicate, type Schema } from "effect";

export const post = (path: string, body: Schema.Json = {}): Request =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/**
 * What `JSON.stringify` accepts, not only valid JSON: `undefined` fields are dropped, and
 * tests send malformed parameters on purpose.
 */
type Value =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<Value>
  | { readonly [key: string]: Value };

/** One stateless 2026-07-28 MCP request. `_meta` is merged over the client metadata. */
interface McpRequestOptions {
  readonly method: string;
  readonly params?: { readonly _meta?: { readonly [key: string]: Value } } & {
    readonly [key: string]: Value;
  };
  readonly headers?: ConstructorParameters<typeof Headers>[0];
  readonly path?: string;
}

/** One stateless 2026-07-28 MCP request to `path`, as `Testing.mcpClient` sends a call. */
export const mcpRequest = ({
  method,
  params = {},
  headers: init,
  path = "/mcp",
}: McpRequestOptions): Request => {
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
      _meta: {
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
        ...params._meta,
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      },
    },
  });

  return new Request(`http://localhost${path}`, { method: "POST", headers, body });
};

/** A raw `tools/call` request, for tests that assert the wire envelope `Testing.mcpClient` removes. */
export const rawToolCall = (name: string, args: Schema.Json = {}): Request =>
  mcpRequest({ method: "tools/call", params: { name, arguments: args } });
