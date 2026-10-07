import { Predicate, type Schema } from "effect";
import { McpProtocol } from "effect/ai";

/**
 * The one protocol revision served over HTTP. 2026-07-28 is stateless: every request
 * stands alone. The stateful revisions keep a session per `initialize`, which the native
 * HTTP runtime never expires and which no identity owns. A mixed endpoint's gate relies on it
 * too: it decides from the routing headers, which the native runtime checks against the body
 * of a stateless request alone, so serving a stateful revision over HTTP would open the gate.
 */
export const httpProtocol = McpProtocol.v2026_07_28;

/** Where `ActionMcp.layerHttp` serves, and `Testing.mcpClient` calls, by default. */
export const defaultPath = "/mcp";

/** An MCP request's parameters: JSON, leaving out an `undefined` one, as a caller may. */
export interface Params {
  readonly _meta?: { readonly [key: string]: Schema.Json };
  readonly [key: string]: Schema.Json | undefined;
}

/** The parameter a method's `mcp-name` header repeats, as the native runtime routes it. */
const routed = (method: string, params: Params) =>
  method === "resources/read" ? params.uri : params.name;

/**
 * One stateless MCP request of `method` with `params`, as `ActionMcp.layerHttp` serves it:
 * the headers routing it, which repeat what its body says, and its JSON-RPC body. The client
 * metadata goes in `_meta`, under any given, such as a `progressToken`; the protocol version
 * is always the request's own.
 */
export const statelessRequest = (method: string, params: Params) => {
  const { protocolVersion } = httpProtocol;
  const name = routed(method, params);

  return {
    headers: {
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": protocolVersion,
      "mcp-method": method,
      ...(Predicate.isString(name) ? { "mcp-name": name } : {}),
    },
    body: {
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "effect-actions", version: "0" },
          ...params._meta,
          "io.modelcontextprotocol/protocolVersion": protocolVersion,
        },
      },
    },
  };
};
