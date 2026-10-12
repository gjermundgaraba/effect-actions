import { Result, Schema } from "effect";
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
