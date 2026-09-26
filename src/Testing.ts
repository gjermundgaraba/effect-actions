import { Effect, Layer, Option, Schema } from "effect";
import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  HttpEffect,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";
import type * as Action from "./Action.js";
import { projectedErrors } from "./internal/actions.js";
import type { OmittableInput } from "./internal/client.js";
import { type Refusal, refusals } from "./internal/errors.js";
import { clientOf, type Served } from "./internal/memory.js";
import { mcpMessage } from "./internal/mcp-request.js";

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

/** Where `mcpCall` sends its call, and with what headers. */
interface McpCallOptions {
  /**
   * The endpoint, resolved by the `HttpClient`: relative under `layer`. Defaults to `/mcp`,
   * the default `ActionMcp.layerHttp` path.
   */
  readonly url?: string;
  readonly headers?: ConstructorParameters<typeof Headers>[0];
}

/**
 * What one call of `A` fails with: a declared error value (the action's own from the tool,
 * or a refusal from the tool or the endpoint's authentication), a `SchemaError` when the
 * input does not encode or the success does not decode, an `HttpClientError` when the
 * endpoint could not be reached, or an `Error` holding the answer for anything else, such as
 * the native server's message for invalid arguments or an unknown tool.
 */
type McpCallError<A extends Action.Any> =
  | A["errors"][number]["Type"]
  | Refusal
  | Schema.SchemaError
  | HttpClientError.HttpClientError
  | Error;

/** The arguments after the action: its input, left out as a client's may be, then options. */
type McpCallArguments<A extends Action.Any> =
  OmittableInput<A> extends true
    ? [input?: A["input"]["Type"], options?: McpCallOptions]
    : [input: A["input"]["Type"], options?: McpCallOptions];

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

/** A value of one of `errors` from its JSON text, if the text is one. */
const failureOf = (errors: Action.Any["errors"], text: string) =>
  Schema.decodeUnknownOption(Schema.fromJsonString(Schema.toCodecJson(Schema.Union(errors))))(text);

/**
 * Call one action's tool with a stateless 2026-07-28 request on the `HttpClient`, such as
 * the one `layer` provides, as `ActionHttp.client` calls its route: the input is encoded
 * with the action's schema, and the success decoded. A declared error the tool returns, the
 * action's own or a refusal, is its decoded value, and so is a refusal the endpoint's
 * authentication answers with.
 */
export function mcpCall<const A extends Action.Any>(
  action: A,
  ...args: McpCallArguments<A>
): Effect.Effect<A["success"]["Type"], McpCallError<A>, HttpClient.HttpClient>;
export function mcpCall(
  action: Action.Any,
  input: Action.Any["input"]["Type"] = {},
  { headers: init, url = "/mcp" }: McpCallOptions = {},
): Effect.Effect<unknown, unknown, HttpClient.HttpClient> {
  const { name } = action;

  const other = (answer: string) => new Error(`MCP tools/call "${name}" ${answer}`);

  return Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(action.input))(input);

    const { headers, body } = mcpMessage({
      method: "tools/call",
      params: { name, arguments: encoded },
      ...(init === undefined ? {} : { headers: init }),
    });

    const response = yield* HttpClient.execute(
      HttpClientRequest.post(url).pipe(
        HttpClientRequest.setHeaders(Object.fromEntries(headers)),
        HttpClientRequest.bodyText(body, "application/json"),
      ),
    );

    const text = yield* response.text;

    if (response.status !== 200) {
      // Only the endpoint's authentication answers otherwise, and only with a refusal.
      const refusal = failureOf(refusals, text);

      return yield* Option.isSome(refusal)
        ? Effect.fail(refusal.value)
        : Effect.fail(other(`answered ${response.status}: ${text}`));
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
      const declared = failureOf(projectedErrors(action, refusals), error);

      return yield* Option.isSome(declared)
        ? Effect.fail(declared.value)
        : Effect.fail(other(`returned an error: ${error}`));
    }

    if (result.structuredContent === undefined) {
      return yield* Effect.fail(other(`returned no structured content: ${text}`));
    }

    return yield* Schema.decodeUnknownEffect(Schema.toCodecJson(action.success))(
      result.structuredContent.value,
    );
  });
}
