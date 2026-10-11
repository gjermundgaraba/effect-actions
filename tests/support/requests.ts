import { Predicate, Result, Schema } from "effect";
import { type Headers, HttpClient, HttpClientRequest } from "effect/http";
import * as Testing from "../../src/testing/Testing.js";

export const send = (request: Request) => HttpClient.execute(HttpClientRequest.fromWeb(request));

export const post = (path: string, body: Schema.Json = {}): Request =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

interface McpRequestOptions {
  readonly method: string;
  readonly params?: Testing.McpParams;
  readonly headers?: Headers.Input;
  readonly path?: string;
}

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

interface SessionRequestOptions {
  readonly method: string;
  readonly params?: Schema.Json;
  readonly session?: string | null;
  readonly headers?: Record<string, string>;
  readonly path?: string;
}

export const initializeParams = {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "session", version: "0" },
} as const;

export const sessionRequest = ({
  method,
  params = {},
  session,
  headers = {},
  path = "/mcp",
}: SessionRequestOptions): Request =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(Predicate.isString(session) ? { "mcp-session-id": session } : {}),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(method.startsWith("notifications/") ? {} : { id: 1 }),
      method,
      params,
    }),
  });

export const endSession = (session: string, path = "/mcp"): Request =>
  new Request(`http://localhost${path}`, {
    method: "DELETE",
    headers: { "mcp-session-id": session, "mcp-protocol-version": "2025-11-25" },
  });

export const rawToolCall = (name: string, args: Schema.Json = {}): Request =>
  mcpRequest({ method: "tools/call", params: { name, arguments: args } });

export const as = (token: string) => ({
  transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
});

const RawToolCallSuccess = Schema.Struct({
  result: Schema.Struct({ structuredContent: Schema.Json }),
});

export const valueOf = async (response: Response): Promise<Schema.Json> =>
  Schema.decodeUnknownSync(RawToolCallSuccess)(await response.json()).result.structuredContent;

export const withBearer = (request: Request, token: string): Request => {
  request.headers.set("authorization", `Bearer ${token}`);

  return request;
};
