import { Effect, Layer, Option, Predicate, Schema, type Scope } from "effect";
import { identity } from "effect/Function";
import {
  type Headers,
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
  HttpEffect,
  HttpRouter,
  HttpServer,
  type HttpServerRequest,
} from "effect/http";
import { Sse } from "effect/encoding";
import type * as Action from "./Action.js";
import { assertDistinct, projectedErrors } from "./internal/actions.js";
import type { Call } from "./internal/client.js";
import { type BuiltIn, refusals } from "./internal/errors.js";
import { defaultPath, type Params, statelessRequest } from "./internal/mcp.js";
import { clientOf, type Served } from "./internal/memory.js";

/**
 * The native `HttpClient`, answered in memory by `routes` instead of the network: provide
 * it to `ActionHttp.client` and to `mcpClient`. The routes are built with this layer and
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
  // Requests run in the context the layer is built in, as under `HttpRouter.serve`: a
  // `TestClock` or reference provided around the program reaches middleware and handlers.
  return Layer.unwrap(
    Effect.gen(function* () {
      const app = yield* HttpRouter.toHttpEffect(
        routes.pipe(Layer.provide(HttpServer.layerServices)),
      );

      const context = yield* Effect.context<never>();

      return clientOf(
        HttpEffect.toWebHandlerWith<never, HttpServerRequest.HttpServerRequest | Scope.Scope>(
          context,
        )(app),
      );
    }),
  );
}

/** Where `mcpClient` sends, and through what client. */
export interface McpClientOptions {
  /**
   * The endpoint, resolved by the `HttpClient`: relative under `layer`. Defaults to `/mcp`,
   * the default `ActionMcp.layerHttp` path.
   */
  readonly url?: string;
  /** Wraps the native `HttpClient`, as `ActionHttp.client` takes it: a bearer token, say. */
  readonly transformClient?: (client: HttpClient.HttpClient) => HttpClient.HttpClient;
}

/** Where `mcpRequest` sends, and with what headers. */
export interface McpRequestOptions {
  /** The endpoint, as `McpClientOptions` has it. */
  readonly url?: string;
  readonly headers?: Headers.Input;
}

/**
 * An answer a client method cannot decode as the action's success or a declared error,
 * such as the native server's message for invalid arguments or an unknown tool. Its message
 * holds the answer.
 */
export class McpCallError extends Schema.TaggedError<McpCallError>()("McpCallError", {
  message: Schema.String,
}) {}

/**
 * What one call of `A` fails with: a declared error value (the action's own or a built-in one
 * from the tool, or a refusal from the endpoint's authentication), a `SchemaError` when the
 * input does not encode or the success does not decode, an `HttpClientError` when the
 * endpoint could not be reached, or an `McpCallError` for any other answer.
 */
type CallError<A extends Action.Any> =
  | A["errors"][number]["Type"]
  | BuiltIn
  | Schema.SchemaError
  | HttpClientError.HttpClientError
  | McpCallError;

/** Every action of `Actions` as `client.<action>(input)`, calling its tool. */
export type McpClient<Actions extends ReadonlyArray<Action.Any>> = {
  readonly [A in Actions[number] as A["name"]]: Call<
    A,
    Effect.Effect<A["success"]["Type"], CallError<A>>
  >;
};

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
 * The reply in a response: its body when it is one JSON message, or the last reply among an
 * event stream's events, which notifications may precede.
 */
const replyOf = (response: HttpClientResponse.HttpClientResponse, text: string) => {
  if (!(response.headers["content-type"] ?? "").startsWith("text/event-stream")) {
    return decodeReply(text);
  }

  const data: Array<string> = [];

  Sse.makeParser((event) => {
    if (Predicate.isTagged(event, "Event")) data.push(event.data);
  }).feed(text);

  return Option.fromNullishOr(
    data.flatMap((message) => Option.toArray(decodeReply(message))).at(-1),
  );
};

/** Fail with the value of one of `errors` that `text` holds, or else with `otherwise`. */
const failWith = (errors: Action.Any["errors"], text: string, otherwise: McpCallError) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.toCodecJson(Schema.Union(errors))))(
    text,
  ).pipe(
    Effect.mapError(() => otherwise),
    Effect.flatMap(Effect.fail),
  );

/** The tool call of `action` with `input` on `client`, sending to `url`. */
const callTool = (
  client: HttpClient.HttpClient,
  url: string,
  action: Action.Any,
  input: Action.Any["input"]["Type"],
): Effect.Effect<unknown, unknown> => {
  const { name } = action;

  const other = (answer: string) =>
    new McpCallError({ message: `MCP tools/call "${name}" ${answer}` });

  return Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(action.input))(input);

    const response = yield* mcpRequest("tools/call", { name, arguments: encoded }, { url }).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
    );

    const text = yield* response.text;

    // Only the endpoint's authentication answers otherwise, and only with a refusal.
    if (response.status !== 200) {
      return yield* failWith(refusals, text, other(`answered ${response.status}: ${text}`));
    }

    const reply = replyOf(response, text);

    if (Option.isNone(reply)) return yield* Effect.fail(other(`had no reply: ${text}`));

    if ("error" in reply.value) {
      const { code, message } = reply.value.error;

      return yield* Effect.fail(other(`failed with ${code}: ${message}`));
    }

    const { result } = reply.value;

    if (result.isError === true) {
      const error = result.content.find((content) => content.type === "text")?.text ?? "";

      return yield* failWith(projectedErrors(action), error, other(`returned an error: ${error}`));
    }

    if (result.structuredContent === undefined) {
      return yield* Effect.fail(other(`returned no structured content: ${text}`));
    }

    return yield* Schema.decodeUnknownEffect(Schema.toCodecJson(action.success))(
      result.structuredContent.value,
    );
  });
};

/**
 * A client of an MCP endpoint served by `ActionMcp.layerHttp`, one method per action calling
 * its tool with one stateless request, as `ActionHttp.client` calls routes: the input is
 * encoded with the action's schema, and the success decoded. A declared error the tool
 * returns, the action's own or a refusal, is its decoded value, and so is a refusal the
 * endpoint's authentication answers with. The argument may be omitted when `{}` is a valid
 * input. Requires the native `HttpClient`, such as the one `layer` provides.
 */
export function mcpClient<const Actions extends ReadonlyArray<Action.Any>>(
  actions: Actions,
  options?: McpClientOptions,
): Effect.Effect<McpClient<Actions>, never, HttpClient.HttpClient>;
export function mcpClient(
  actions: ReadonlyArray<Action.Any>,
  { url = defaultPath, transformClient = identity }: McpClientOptions = {},
): Effect.Effect<
  {
    readonly [name: string]: (...input: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown>;
  },
  never,
  HttpClient.HttpClient
> {
  assertDistinct("action", actions, (action) => action.name);

  return Effect.map(HttpClient.HttpClient, (native) => {
    const client = transformClient(native);

    return Object.fromEntries(
      actions.map((action) => [
        action.name,
        // A method takes no argument only when `{}` is a valid input; a given one is sent.
        (...input: ReadonlyArray<unknown>) =>
          callTool(client, url, action, input.length === 0 ? {} : input[0]),
      ]),
    );
  });
}

/**
 * Send one stateless MCP request of `method` with `params`, as `ActionMcp.layerHttp` serves
 * it, on the `HttpClient`: the JSON-RPC envelope, the 2026-07-28 headers, `mcp-name` from
 * `params.name`, and the client metadata in `_meta` are filled in, under any `_meta` given,
 * such as a `progressToken`; the protocol version is always the request's own. It succeeds
 * with the response as the endpoint sent it, whatever its status: for a test asserting on
 * what `mcpClient` decodes away, such as `tools/list`, a refusal's challenge, or a call its
 * types would not send.
 */
export const mcpRequest = (
  method: string,
  params: Params = {},
  { headers = {}, url = defaultPath }: McpRequestOptions = {},
): Effect.Effect<
  HttpClientResponse.HttpClientResponse,
  HttpClientError.HttpClientError,
  HttpClient.HttpClient
> => {
  const { headers: routing, body } = statelessRequest(method, params);

  // The routing headers go over any the caller sets.
  return HttpClient.execute(
    HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.setHeaders(routing),
      HttpClientRequest.bodyJsonUnsafe(body),
    ),
  );
};
