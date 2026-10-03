import { Predicate, type Schema, type Types } from "effect";
import { McpProtocol } from "effect/ai";
import type * as Action from "../Action.js";

/**
 * The one protocol revision served over HTTP. 2026-07-28 is stateless: every request
 * stands alone. The stateful revisions keep a session per `initialize`, which the native
 * HTTP runtime never expires and which no identity owns.
 */
export const httpProtocol = McpProtocol.v2026_07_28;

/** Where `ActionMcp.layerHttp` serves, and `Testing.mcpClient` calls, by default. */
export const defaultPath = "/mcp";

/** The keys `E` declares, leaving out an index signature's. */
type DeclaredKey<E> = keyof {
  [
    K in keyof E as string extends K
      ? never
      : number extends K
        ? never
        : symbol extends K
          ? never
          : K
  ]: E[K];
};

/**
 * The fields of `A`'s encoded success its tool may send as text: the top-level string fields
 * a struct or class declares, optional ones included, and not the keys of an index signature,
 * such as a struct with rest's record. None of any other success, a union or a record among
 * them, whose JSON Schema has no top-level property for it. An erased success may name any;
 * the server refuses what the types cannot see when its layer is built.
 */
export type TextField<A extends Action.Any> = A["success"]["Encoded"] extends infer E
  ? unknown extends E
    ? string
    : true extends Types.IsUnion<E>
      ? never
      : E extends ReadonlyArray<unknown>
        ? never
        : E extends object
          ? {
              readonly [K in DeclaredKey<E>]-?: Required<E>[K] extends string ? K : never;
            }[DeclaredKey<E>] &
              string
          : never
  : never;

/** How the tool of each action of `A` sends its success, by action name. */
export type ToolOptions<A extends Action.Any> = {
  readonly [K in A as K["name"]]?: {
    /**
     * A string field of the encoded success, the text field, which MCP sends once, raw, as
     * the first text block, then the JSON of the rest as the second, with no
     * `structuredContent` and no listed `outputSchema` for the tool, so every host shows the
     * model both: a body the model reads as it is, such as a page of Markdown.
     */
    readonly text?: TextField<K>;
  };
};

/** A JSON value that is an object: neither null, a scalar nor an array. */
export const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Predicate.isObject(value);

/** An MCP request's parameters: JSON, leaving out an `undefined` one, as a caller may. */
export interface Params {
  readonly _meta?: { readonly [key: string]: Schema.Json };
  readonly [key: string]: Schema.Json | undefined;
}

/**
 * One stateless MCP request of `method` with `params`, as `ActionMcp.layerHttp` serves it:
 * the headers routing it, which repeat what its body says, and its JSON-RPC body. The client
 * metadata goes in `_meta`, under any given, such as a `progressToken`; the protocol version
 * is always the request's own.
 */
export const statelessRequest = (method: string, params: Params) => {
  const { protocolVersion } = httpProtocol;

  return {
    headers: {
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": protocolVersion,
      "mcp-method": method,
      ...(Predicate.isString(params.name) ? { "mcp-name": params.name } : {}),
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
