import { Predicate } from "effect";
import type { Schema } from "effect";
import { HttpClientRequest } from "effect/http";
import type { Headers } from "effect/http";

import { defaultPath, httpProtocol } from "./protocol.js";

/**
 * An MCP request's parameters, as `request` takes them: JSON, with any `_meta`, leaving
 * out an `undefined` one, as a caller may. A helper passing on whole params types them as this,
 * and a tool's `arguments` as `Schema.Json`, never `unknown`.
 */
export interface Params {
  readonly _meta?: { readonly [key: string]: Schema.Json };
  readonly [key: string]: Schema.Json | undefined;
}

export const statelessRequest = (method: string, params: Params) => {
  const { protocolVersion } = httpProtocol;
  const name = method === "resources/read" ? params["uri"] : params["name"];

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
          "io.modelcontextprotocol/clientInfo": {
            name: "effect-actions",
            version: "0",
          },
          ...params._meta,
          "io.modelcontextprotocol/protocolVersion": protocolVersion,
        },
      },
    },
  };
};

/** Where a `request` goes, and with what headers. */
export interface RequestOptions {
  /**
   * The endpoint, resolved by the `HttpClient` that sends the request: relative under `Testing.layer`.
   * Defaults to `/mcp`, as `client`'s does; converting to a web `Request` needs an absolute
   * one.
   */
  readonly url?: string;
  /**
   * Headers sent beside the routing ones `request` fills in, such as `Authorization`; a routing
   * header wins over a given one of its name.
   */
  readonly headers?: Headers.Input;
}

/**
 * One stateless MCP request of `method` with `params`, as `layerHttp` serves it,
 * as the native request value: the JSON-RPC envelope, the 2026-07-28 headers (`Accept`,
 * `MCP-Protocol-Version`, `MCP-Method`), `mcp-name` from
 * `params.uri` for `resources/read` and `params.name` otherwise, and the client metadata in
 * `_meta` are filled in, under any `_meta` given, such as a `progressToken`; the protocol
 * version is always the request's own. The test sends it: `HttpClient.execute` answers the
 * response as the endpoint sent it, whatever its status, and `HttpClientRequest.toWebResult`
 * gives the web `Request` a web handler or `fetch` takes, once `url` is absolute. It is for a test
 * asserting on what `client` decodes away, such as `tools/list`, a refusal's challenge, or
 * a call its types would not send.
 */
export const request = (
  method: string,
  params: Params = {},
  { headers = {}, url = defaultPath }: RequestOptions = {}
): HttpClientRequest.HttpClientRequest => {
  const { headers: routingHeaders, body } = statelessRequest(method, params);

  return HttpClientRequest.post(url).pipe(
    HttpClientRequest.setHeaders(headers),
    HttpClientRequest.setHeaders(routingHeaders),
    HttpClientRequest.bodyJsonUnsafe(body)
  );
};
