import {
  Context,
  Effect,
  FileSystem,
  identity,
  Layer,
  Option,
  Path,
  Predicate,
  Schema,
  type Scope,
} from "effect";
import {
  Etag,
  type Headers,
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
  HttpEffect,
  HttpPlatform,
  HttpRouter,
  type HttpServerRequest,
} from "effect/http";
import { Sse } from "effect/encoding";
import type * as Action from "./Action.js";
import { assertOnce, projectedErrors } from "./internal/actions.js";
import { type Call, inputOf } from "./internal/call.js";
import { type BuiltIn, refusals } from "./internal/errors.js";
import { defaultPath, type Params, statelessRequest } from "./internal/mcp.js";
import { clientOf, type Served } from "./internal/memory.js";

/**
 * The native `HttpClient`, answered by `handler` instead of the network: a web handler the
 * test serves, which other tests may share, such as
 * `HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices))).handler`,
 * the routes' platform services provided, as `layer(routes)` provides them itself. It is the
 * client `layer(routes)` gives, without building anything: the test owns the handler, and
 * disposes of it.
 */
export function layer(
  handler: (request: Request) => Promise<Response>,
): Layer.Layer<HttpClient.HttpClient>;
// Last: TypeScript reports a call matching no overload by the last one's error alone, so an
// argument that is neither form is reported against the routes.
/**
 * The native `HttpClient`, answered in memory by `routes` instead of the network: provide
 * it to `ActionHttp.client` and to `mcpClient`. The routes are built with this layer and
 * released with its scope, without request logs. What they still require is this layer's, as
 * under `HttpRouter.serve`: a builder's services, and a per-request service no middleware of
 * theirs provides, including one a global middleware reads, such as the caller a test stands
 * in for authentication. Provided around it, the test program shares them. It never requires
 * the platform services, `FileSystem`, `Path`, `HttpPlatform` and `Etag.Generator`: one
 * provided around it is the routes' too, and `HttpServer.layerServices`' defaults stand in for
 * the rest, whose `FileSystem` is a no-op. A relative URL resolves against `http://localhost`.
 * The client is the layer's own: the program's other HTTP clients get none of its requests,
 * and it none of theirs.
 */
export function layer<A, E, R>(
  routes: Layer.Layer<A, E, R>,
): Layer.Layer<
  HttpClient.HttpClient,
  E,
  Exclude<
    | HttpRouter.Request.Without<R>
    | HttpRouter.Request.Only<"Requires", R>
    | HttpRouter.Request.Only<"GlobalRequires", R>,
    Served
  >
>;
export function layer(
  routes: Layer.Layer<unknown, unknown, unknown> | ((request: Request) => Promise<Response>),
): Layer.Layer<HttpClient.HttpClient, unknown, unknown> {
  // A web handler the test serves, which builds and releases its routes itself.
  if (!Layer.isLayer(routes)) return clientOf(routes);

  return Layer.unwrap(
    Effect.gen(function* () {
      // The platform services `HttpServer.layerServices` has, beneath the program's own at
      // build and per request, so one provided around the layer wins. Supplied rather than
      // required: every `ActionHttp.layer` declares them, so every test would owe them. The
      // default `HttpPlatform` serves files from the program's `FileSystem`, or else from a
      // no-op one; built fresh, so that no platform built elsewhere in the program, on another
      // `FileSystem`, stands in for it.
      const fileSystem = Option.getOrElse(yield* Effect.serviceOption(FileSystem.FileSystem), () =>
        FileSystem.makeNoop({}),
      );

      const platform = yield* Layer.build(
        Layer.fresh(
          Layer.mergeAll(HttpPlatform.layer, Path.layer, Etag.layerWeak).pipe(
            Layer.provideMerge(Layer.succeed(FileSystem.FileSystem, fileSystem)),
          ),
        ),
      );

      // Requests run in the context the layer is built in, as under `HttpRouter.serve`: a
      // `TestClock` or reference provided around the program reaches middleware and handlers.
      const context = Context.merge(platform, yield* Effect.context<never>());

      const app = yield* HttpRouter.toHttpEffect(routes).pipe(Effect.provideContext(context));

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

/** A tool result, as `mcpClient` reads it. */
const ToolResult = Schema.Struct({
  isError: Schema.optionalKey(Schema.Boolean),
  structuredContent: Schema.optionalKey(Schema.Json),
  content: Schema.Array(
    Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }),
  ),
});

/** The JSON-RPC response to a `tools/call`: a tool result or a protocol error. */
const ToolReply = Schema.Union([
  Schema.Struct({ result: ToolResult }),
  Schema.Struct({ error: Schema.Struct({ code: Schema.Finite, message: Schema.String }) }),
]);

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

const decodeObject = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.JsonObject));

/**
 * The success a tool with the text field `field` sends as text, without structured content:
 * the field raw in the first block and the JSON of the rest in the second, or the JSON of the
 * whole in one block when the success holds no string there. `None` for any other content.
 */
const textSuccessOf = (
  content: (typeof ToolResult.Type)["content"],
  field: string,
): Option.Option<Schema.Json> => {
  const [first, second, ...others] = content;
  const raw = first?.text;

  if (raw === undefined || others.length > 0) return Option.none();

  if (second === undefined) return decodeJson(raw);

  return Option.map(
    second.text === undefined ? Option.none() : decodeObject(second.text),
    (rest) => ({ ...rest, [field]: raw }),
  );
};

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

/**
 * The tool call of `action` with `input` on `client`, sending to `url`, whose success the
 * tool sends as text when the action has a `text` hint.
 */
const callTool = (
  client: HttpClient.HttpClient,
  url: string,
  action: Action.Any,
  input: Action.Any["input"]["Type"],
): Effect.Effect<unknown, unknown> => {
  const {
    name,
    hints: { text: field },
  } = action;

  const other = (answer: string) =>
    new McpCallError({ message: `MCP tools/call "${name}" ${answer}` });

  return Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(action.input))(input);

    const response = yield* mcpRequest("tools/call", { name, arguments: encoded }, { url }).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
    );

    const text = yield* response.text;

    // Only authentication answers otherwise: a refusal of its own, or a hook's or handler's
    // step-up refusal.
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

    // A tool with a text field sends its success as text; any other, as structured content.
    const success =
      field !== undefined
        ? textSuccessOf(result.content, field)
        : result.structuredContent === undefined
          ? Option.none()
          : Option.some(result.structuredContent);

    if (Option.isNone(success)) {
      const missing = field === undefined ? "no structured content" : "no success as text";

      return yield* Effect.fail(other(`returned ${missing}: ${text}`));
    }

    return yield* Schema.decodeUnknownEffect(Schema.toCodecJson(action.success))(success.value);
  });
};

/**
 * A client of an MCP endpoint served by `ActionMcp.layerHttp`, one method per action calling
 * its tool with one stateless request, as `ActionHttp.client` calls routes: the input is
 * encoded with the action's schema, and the success decoded, from the text blocks of a tool
 * whose action has a `text` hint. A declared error the tool returns, the action's own or a
 * refusal, is its decoded value, and so is a refusal the endpoint's authentication answers
 * with. The argument may be omitted when `{}` is a valid input. Requires the native
 * `HttpClient`, such as the one `layer` provides.
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
  assertOnce("action", actions);

  return Effect.map(HttpClient.HttpClient, (native) => {
    const client = transformClient(native);

    return Object.fromEntries(
      actions.map((action) => {
        return [
          action.name,
          (...args: ReadonlyArray<Action.Any["input"]["Type"]>) =>
            Effect.flatMap(inputOf(action, args), (input) => callTool(client, url, action, input)),
        ];
      }),
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
