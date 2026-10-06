import { Result, Schema } from "effect";
import { type Headers, HttpClient, HttpClientRequest } from "effect/http";
import type { Params } from "../src/internal/mcp.js";
import * as Testing from "../src/Testing.js";

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
  readonly headers?: Headers.Input;
  readonly path?: string;
}

/** One stateless MCP request to `path`, `Testing.mcpRequest`'s, as a web request. */
export const mcpRequest = ({
  method,
  params = {},
  headers = {},
  path = "/mcp",
}: McpRequestOptions): Request =>
  Result.getOrThrow(
    HttpClientRequest.toWebResult(
      Testing.mcpRequest(method, params, { url: `http://localhost${path}`, headers }),
    ),
  );

/**
 * A raw `tools/call` request, for tests asserting on the JSON-RPC response as sent: the tool
 * result's fields and content blocks, which `Testing.mcpClient` decodes away.
 */
export const rawToolCall = (name: string, args: Schema.Json = {}): Request =>
  mcpRequest({ method: "tools/call", params: { name, arguments: args } });

/** Client options sending `token`, a demo actor's name, as its bearer token. */
export const as = (token: string) => ({
  transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
});

/** A raw MCP tool call's response, holding the encoded success as its structured content. */
const McpSuccess = Schema.Struct({
  result: Schema.Struct({ structuredContent: Schema.Json }),
});

/** The encoded success of a raw MCP tool call's response, as its structured content. */
export const valueOf = async (response: Response): Promise<Schema.Json> =>
  Schema.decodeUnknownSync(McpSuccess)(await response.json()).result.structuredContent;

/** `request`, signed in as the demo actor `token` names, as `examples/authentication.ts` verifies it. */
export const withBearer = (request: Request, token: string): Request => {
  request.headers.set("authorization", `Bearer ${token}`);

  return request;
};
