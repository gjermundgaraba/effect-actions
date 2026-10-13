import { Cause, Effect, Exit, Predicate, Result, Schema } from "effect";
import { type Headers, HttpClient, HttpClientRequest } from "effect/http";
import * as Action from "../../src/contract/Action.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";

export const send = (request: Request) => HttpClient.execute(HttpClientRequest.fromWeb(request));

export const post = (path: string, body: Schema.Json = {}): Request =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

interface McpRequestOptions {
  readonly method: string;
  readonly params?: ActionMcp.Params;
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
      ActionMcp.request(method, params, { url: `http://localhost${path}`, headers }),
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

export const sessionMessage = (
  method: string,
  params?: Schema.Json | ActionMcp.Params,
  id = 1,
) => ({
  jsonrpc: "2.0",
  ...(method.startsWith("notifications/") ? {} : { id }),
  method,
  ...(params === undefined ? {} : { params }),
});

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
    body: JSON.stringify(sessionMessage(method, params)),
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

const RawRequest = Schema.TaggedStruct("Request", {
  id: Schema.String,
  tag: Schema.String,
  payload: Schema.Json,
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
});

const RawAnswer = Schema.fromJsonString(
  Schema.Struct({
    exit: Schema.toCodecJson(Schema.Exit(Schema.Json, Action.BuiltIn, Schema.Defect())),
  }),
);

export const valueOrSquashedCause = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit) ? exit.value : Cause.squash(exit.cause);

export interface RawMessage {
  readonly tag: string;
  readonly payload: Schema.Json;
  readonly headers?: ReadonlyArray<readonly [string, string]>;
}

export const sendRawNdjson = (messages: ReadonlyArray<RawMessage>, token?: string) =>
  Effect.gen(function* () {
    const body = messages
      .map(({ tag, payload, headers = [] }, id) =>
        JSON.stringify(RawRequest.make({ id: String(id), tag, payload, headers })),
      )
      .join("\n");

    const request = HttpClientRequest.post("/rpc").pipe(
      HttpClientRequest.bodyText(`${body}\n`, "application/ndjson"),
    );

    const response = yield* HttpClient.execute(
      token === undefined ? request : HttpClientRequest.bearerToken(request, token),
    );

    const text = yield* response.text;

    return {
      text,
      exits: text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => Schema.decodeUnknownSync(RawAnswer)(line).exit),
    };
  });
