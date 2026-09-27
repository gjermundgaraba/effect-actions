import { Effect, Layer, Option, Predicate, Schema } from "effect";
import {
  type Headers,
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
  HttpEffect,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";
import type * as Action from "./Action.js";
import { projectedErrors } from "./internal/actions.js";
import type { OmittableInput } from "./internal/client.js";
import { type Refusal, refusals } from "./internal/errors.js";
import { defaultPath, httpProtocol } from "./internal/mcp.js";
import { clientOf, type Served } from "./internal/memory.js";

/**
 * The native `HttpClient`, answered in memory by `routes` instead of the network: provide
 * it to `ActionHttp.client` and to `mcpCall`. The routes are built with this layer and
 * released with its scope, without request logs, with the platform services
 * `HttpServer.layerServices` provides. They must satisfy their per-request requirements
 * themselves, with their middleware. A relative URL resolves against `http://localhost`.
 */
export function layer<A, E, R extends Served>(
  routes: Layer.Layer<A, E, R>,
): Layer.Layer<HttpClient.HttpClient, E>;
export function layer(
  routes: Layer.Layer<unknown, unknown, Served>,
): Layer.Layer<HttpClient.HttpClient, unknown> {
  return Layer.unwrap(
    Effect.map(
      HttpRouter.toHttpEffect(routes.pipe(Layer.provide(HttpServer.layerServices))),
      (app) => clientOf(HttpEffect.toWebHandler(app)),
    ),
  );
}

/** Where `mcpCall` and `mcpRequest` send, and with what headers. */
export interface McpCallOptions {
  /**
   * The endpoint, resolved by the `HttpClient`: relative under `layer`. Defaults to `/mcp`,
   * the default `ActionMcp.layerHttp` path.
   */
  readonly url?: string;
  readonly headers?: Headers.Input;
}

/**
 * An answer `mcpCall` cannot decode as the action's success or a declared error, such as
 * the native server's message for invalid arguments or an unknown tool. Its message holds
 * the answer.
 */
export class McpCallError extends Schema.TaggedError<McpCallError>()("McpCallError", {
  message: Schema.String,
}) {}

/**
 * What one call of `A` fails with: a declared error value (the action's own from the tool,
 * or a refusal from the tool or the endpoint's authentication), a `SchemaError` when the
 * input does not encode or the success does not decode, an `HttpClientError` when the
 * endpoint could not be reached, or an `McpCallError` for any other answer.
 */
type CallError<A extends Action.Any> =
  | A["errors"][number]["Type"]
  | Refusal
  | Schema.SchemaError
  | HttpClientError.HttpClientError
  | McpCallError;

/**
 * The arguments after the action: its input, then options. As for a client's method, the input
 * may be left out when `{}` is valid, sending `{}`, and a given input is sent as given; with
 * options, it is given.
 */
type McpCallArguments<A extends Action.Any> =
  | (OmittableInput<A> extends true ? [] : never)
  | [input: A["input"]["Type"], options?: McpCallOptions];

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

/**
 * The reply in a response body: the body itself when it is one JSON message, or else the
 * last reply among an event stream's `data:` lines, which notifications may precede.
 */
const replyOf = (text: string) =>
  Option.orElse(decodeReply(text), () =>
    Option.fromNullishOr(
      text
        .split("\n")
        .map((line) => line.replace(/^data:/, "").trim())
        .flatMap((line) => Option.toArray(decodeReply(line)))
        .at(-1),
    ),
  );

/** Fail with the value of one of `errors` that `text` holds, or else with `otherwise`. */
const failWith = (errors: Action.Any["errors"], text: string, otherwise: McpCallError) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.toCodecJson(Schema.Union(errors))))(
    text,
  ).pipe(
    Effect.mapError(() => otherwise),
    Effect.flatMap(Effect.fail),
  );

/**
 * Call one action's tool with one stateless request, as `ActionMcp.layerHttp` serves it,
 * on the `HttpClient`, such as the one `layer` provides, as `ActionHttp.client` calls its
 * route: the input is encoded with the action's schema, and the success decoded. A declared
 * error the tool returns, the action's own or a refusal, is its decoded value, and so is a
 * refusal the endpoint's authentication answers with.
 */
export function mcpCall<const A extends Action.Any>(
  action: A,
  ...args: McpCallArguments<A>
): Effect.Effect<A["success"]["Type"], CallError<A>, HttpClient.HttpClient>;
export function mcpCall(
  action: Action.Any,
  ...args: [] | [input: Action.Any["input"]["Type"], options?: McpCallOptions]
): Effect.Effect<unknown, unknown, HttpClient.HttpClient> {
  const { name } = action;
  const [input, options] = args.length === 0 ? [{}] : args;

  const other = (answer: string) =>
    new McpCallError({ message: `MCP tools/call "${name}" ${answer}` });

  return Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(action.input))(input);

    const response = yield* mcpRequest("tools/call", { name, arguments: encoded }, options);

    const text = yield* response.text;

    // Only the endpoint's authentication answers otherwise, and only with a refusal.
    if (response.status !== 200) {
      return yield* failWith(refusals, text, other(`answered ${response.status}: ${text}`));
    }

    const reply = replyOf(text);

    if (Option.isNone(reply)) return yield* Effect.fail(other(`had no reply: ${text}`));

    if ("error" in reply.value) {
      const { code, message } = reply.value.error;

      return yield* Effect.fail(other(`failed with ${code}: ${message}`));
    }

    const { result } = reply.value;

    if (result.isError === true) {
      const error = result.content.find((content) => content.type === "text")?.text ?? "";

      return yield* failWith(
        projectedErrors(action, refusals),
        error,
        other(`returned an error: ${error}`),
      );
    }

    if (result.structuredContent === undefined) {
      return yield* Effect.fail(other(`returned no structured content: ${text}`));
    }

    return yield* Schema.decodeUnknownEffect(Schema.toCodecJson(action.success))(
      result.structuredContent.value,
    );
  });
}

/** A request's parameters: JSON, and request metadata merged over the client's. */
interface McpParams {
  readonly _meta?: { readonly [key: string]: Schema.Json };
  readonly [key: string]: Schema.Json | undefined;
}

/** The parameter naming what a request of `method` routes to, as MCP 2026-07-28 defines it. */
const routingKey = (method: string): string | undefined =>
  method === "tools/call" || method === "prompts/get"
    ? "name"
    : method === "resources/read"
      ? "uri"
      : undefined;

/**
 * Send one stateless MCP request of `method` with `params`, as `ActionMcp.layerHttp` serves
 * it, on the `HttpClient`: the JSON-RPC envelope, the 2026-07-28 headers, and the client
 * metadata in `_meta`, over which a `_meta` of `params` is merged, are filled in. It succeeds
 * with the response as the endpoint sent it, whatever its status: for a test asserting on
 * what `mcpCall` decodes away, such as `tools/list`, a refusal's challenge, or a call its
 * types would not send.
 */
export const mcpRequest = (
  method: string,
  params: McpParams = {},
  { headers = {}, url = defaultPath }: McpCallOptions = {},
): Effect.Effect<
  HttpClientResponse.HttpClientResponse,
  HttpClientError.HttpClientError,
  HttpClient.HttpClient
> => {
  const { protocolVersion } = httpProtocol;
  const key = routingKey(method);
  const routed = key === undefined ? undefined : params[key];
  const { _meta: meta = {}, ...rest } = params;

  // One stateless request: its routing headers, over any the caller sets, repeat what its
  // body says.
  return HttpClient.execute(
    HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.setHeaders({
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": protocolVersion,
        "mcp-method": method,
        ...(Predicate.isString(routed) ? { "mcp-name": routed } : {}),
      }),
      HttpClientRequest.bodyJsonUnsafe({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...rest,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": protocolVersion,
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": { name: "effect-actions", version: "0" },
            ...meta,
          },
        },
      }),
    ),
  );
};
