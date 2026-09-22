import { Effect, Layer, Option, Predicate, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { type HttpApi, HttpApiClient, type HttpApiGroup } from "effect/unstable/httpapi";

/** A web handler, such as `HttpRouter.toWebHandler(routes).handler`. */
export type Handler = (request: Request) => Promise<Response>;

/**
 * The native grouped HTTP client, calling `handler` in memory instead of the network.
 * `baseUrl` defaults to `http://localhost`.
 */
export const httpClient = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
  handler: Handler,
  options?: NonNullable<Parameters<typeof HttpApiClient.make>[1]>,
) =>
  HttpApiClient.make(api, { baseUrl: "http://localhost", ...options }).pipe(
    Effect.provide(
      FetchHttpClient.layer.pipe(
        Layer.provide(
          Layer.succeed(FetchHttpClient.Fetch, (input, init) => handler(new Request(input, init))),
        ),
      ),
    ),
  );

/** A stateless 2026-07-28 request. */
export interface McpRequestOptions {
  readonly url: string | URL;
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

/** JSON-RPC `params`; `_meta` is merged shallowly over the defaults `mcpRequest` supplies. */
export interface McpRequestParams {
  readonly _meta?: { readonly [key: string]: McpRequestValue };
  readonly [key: string]: McpRequestValue;
}

/** Build one stateless 2026-07-28 JSON-RPC request, with client metadata defaulted. */
export const mcpRequest = ({
  url,
  method,
  params = {},
  headers: init,
}: McpRequestOptions): Request => {
  const headers = new Headers(init);
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json, text/event-stream");
  headers.set("mcp-protocol-version", "2026-07-28");
  headers.set("mcp-method", method);

  if (Predicate.isString(params.name)) headers.set("mcp-name", params.name);

  return new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
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
    }),
  });
};

/** One `tools/call` for `mcpCall`: the endpoint, the tool and its arguments. */
export interface McpCallOptions {
  readonly url: string | URL;
  /** The tool name, `mcp.name` of its action. */
  readonly name: string;
  /** Defaults to `{}`. Like `params`, it may be malformed on purpose. */
  readonly arguments?: { readonly [key: string]: McpRequestValue };
  readonly headers?: ConstructorParameters<typeof Headers>[0];
}

/**
 * A tool call's outcome with the library's wire envelope removed: the success from
 * `structuredContent.value`, or the error text of an `isError` result, parsed as JSON
 * when it is JSON (a declared error) and kept as the text otherwise (the native
 * server's own message, such as for invalid arguments).
 */
export type McpCallResult =
  | { readonly isError: false; readonly value: Schema.Json }
  | { readonly isError: true; readonly error: Schema.Json };

/** The JSON-RPC response to a `tools/call`: a tool result or a protocol error. */
const ToolReply = Schema.Union([
  Schema.Struct({
    result: Schema.Struct({
      isError: Schema.optionalKey(Schema.Boolean),
      structuredContent: Schema.optionalKey(Schema.Struct({ value: Schema.Json })),
      content: Schema.Array(
        Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }),
      ),
    }),
  }),
  Schema.Struct({ error: Schema.Struct({ code: Schema.Finite, message: Schema.String }) }),
]);

const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(ToolReply));

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/**
 * Call one tool through `handler` with a stateless 2026-07-28 request and return its
 * outcome. A response that is not an HTTP 200 carrying a tool result, such as an
 * authentication refusal or a JSON-RPC error, throws; use `mcpRequest` to inspect one.
 */
export const mcpCall = async (
  handler: Handler,
  { url, name, headers, ...options }: McpCallOptions,
): Promise<McpCallResult> => {
  const response = await handler(
    mcpRequest({
      url,
      method: "tools/call",
      params: { name, arguments: options.arguments ?? {} },
      ...(headers === undefined ? {} : { headers }),
    }),
  );

  const body = await response.text();

  if (response.status !== 200) {
    throw new Error(`MCP tools/call "${name}" answered ${response.status}: ${body}`);
  }

  // A JSON body is one message; an event stream carries one per `data:` line, and
  // notifications may precede the reply.
  const reply = body
    .split("\n")
    .map((line) => line.replace(/^data:/, "").trim())
    .flatMap((line) => Option.toArray(decodeReply(line)))
    .at(-1);

  if (reply === undefined) throw new Error(`MCP tools/call "${name}" had no reply: ${body}`);

  if ("error" in reply) {
    throw new Error(
      `MCP tools/call "${name}" failed with ${reply.error.code}: ${reply.error.message}`,
    );
  }

  const { result } = reply;

  if (result.isError === true) {
    const text = result.content.find((content) => content.type === "text")?.text ?? "";

    return { isError: true, error: Option.getOrElse(parseJson(text), () => text) };
  }

  if (result.structuredContent === undefined) {
    throw new Error(`MCP tools/call "${name}" returned no structured content: ${body}`);
  }

  return { isError: false, value: result.structuredContent.value };
};
