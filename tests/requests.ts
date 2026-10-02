import type { Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { type Params, statelessRequest } from "../src/internal/mcp.js";

/** Send a web request with the `HttpClient` in context, such as `Testing.layer(routes)`'s. */
export const send = (request: Request) => HttpClient.execute(HttpClientRequest.fromWeb(request));

export const post = (path: string, body: Schema.Json = {}): Request =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** What `mcpRequest` sends: a method, its parameters, extra headers, and the endpoint path. */
interface McpRequestOptions {
  readonly method: string;
  readonly params?: Params;
  readonly headers?: ConstructorParameters<typeof Headers>[0];
  readonly path?: string;
}

/** One stateless MCP request to `path`, as `Testing.mcpRequest` sends it, as a web request. */
export const mcpRequest = ({
  method,
  params = {},
  headers: init,
  path = "/mcp",
}: McpRequestOptions): Request => {
  const { headers: routing, body } = statelessRequest(method, params);
  const headers = new Headers(init);

  headers.set("content-type", "application/json");

  for (const [name, value] of Object.entries(routing)) headers.set(name, value);

  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
};

/**
 * A raw `tools/call` request, for tests asserting on the JSON-RPC response as sent: the tool
 * result's fields and content blocks, which `Testing.mcpClient` decodes away.
 */
export const rawToolCall = (name: string, args: Schema.Json = {}): Request =>
  mcpRequest({ method: "tools/call", params: { name, arguments: args } });
