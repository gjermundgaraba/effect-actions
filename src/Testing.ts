import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Schema,
  type Scope,
} from "effect";
import { identity } from "effect/Function";
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
import { assertDistinct, projectedErrors } from "./internal/actions.js";
import { type Call, inputOf } from "./internal/call.js";
import { type BuiltIn, refusals } from "./internal/errors.js";
import {
  defaultPath,
  isJsonObject,
  type Params,
  statelessRequest,
  type ToolOptions,
} from "./internal/mcp.js";
import { clientOf, type Served } from "./internal/memory.js";

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
  routes: Layer.Layer<unknown, unknown, unknown>,
): Layer.Layer<HttpClient.HttpClient, unknown, unknown> {
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

/**
 * Where `mcpClient` sends, through what client, and how the endpoint sends the successes of
 * the actions `A`.
 */
export interface McpClientOptions<A extends Action.Any = Action.Any> {
  /**
   * The endpoint, resolved by the `HttpClient`: relative under `layer`. Defaults to `/mcp`,
   * the default `ActionMcp.layerHttp` path.
   */
  readonly url?: string;
  /** Wraps the native `HttpClient`, as `ActionHttp.client` takes it: a bearer token, say. */
  readonly transformClient?: (client: HttpClient.HttpClient) => HttpClient.HttpClient;
  /**
   * The endpoint's `tools`, as `ActionMcp.layerHttp` takes them: a text field the endpoint
   * sends as raw text is put back under its field before the success is decoded. An entry of
   * an action the client does not call is not read.
   */
  readonly tools?: ToolOptions<A>;
}

/**
 * The options of a client of `Actions`, read by a fixed key from a type distributed over
 * `Actions`, so where `Actions` is a helper's own type parameter, spread into a list, the
 * compiler reads them through the helper's constraint: `tools` checks the entries of the
 * helper's own actions, and takes any other name.
 */
type ClientOptions<Actions extends ReadonlyArray<Action.Any>> = (Actions extends unknown
  ? { readonly typed: McpClientOptions<Actions[number]> }
  : never)["typed"];

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

/**
 * The success of a result from its content and its structured content: a text field `field`
 * the endpoint sent as raw text, the first of two blocks, put back into the structured rest.
 * A success sent whole has one block, its JSON.
 */
const successOf = (
  content: (typeof ToolResult.Type)["content"],
  structured: Schema.Json,
  field: string | undefined,
): Schema.Json => {
  const [text, rest] = content;

  if (
    field === undefined ||
    rest === undefined ||
    text?.text === undefined ||
    !isJsonObject(structured)
  ) {
    return structured;
  }

  // oxlint-disable-next-line typescript/no-misused-spread -- A misfire: `Schema.JsonObject` is an interface merged with a schema value, which the rule takes for a class; this is the response's decoded JSON, with no prototype to lose.
  return { ...structured, [field]: text.text };
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
 * The tool call of `action` with `input` on `client`, sending to `url`, whose success has
 * the text field `field`, if any.
 */
const callTool = (
  client: HttpClient.HttpClient,
  url: string,
  action: Action.Any,
  field: string | undefined,
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

    if (result.structuredContent === undefined) {
      return yield* Effect.fail(other(`returned no structured content: ${text}`));
    }

    return yield* Schema.decodeUnknownEffect(Schema.toCodecJson(action.success))(
      successOf(result.content, result.structuredContent, field),
    );
  });
};

/**
 * A client of an MCP endpoint served by `ActionMcp.layerHttp`, one method per action calling
 * its tool with one stateless request, as `ActionHttp.client` calls routes: the input is
 * encoded with the action's schema, and the success decoded, a text field the endpoint's
 * `tools` name put back first. A declared error the tool returns, the action's own or a
 * refusal, is its decoded value, and so is a refusal the endpoint's authentication answers
 * with. The argument may be omitted when `{}` is a valid input. Requires the native
 * `HttpClient`, such as the one `layer` provides.
 */
export function mcpClient<const Actions extends ReadonlyArray<Action.Any>>(
  actions: Actions,
  options?: NoInfer<ClientOptions<Actions>>,
): Effect.Effect<McpClient<Actions>, never, HttpClient.HttpClient>;
export function mcpClient(
  actions: ReadonlyArray<Action.Any>,
  { url = defaultPath, transformClient = identity, tools = {} }: McpClientOptions = {},
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
      actions.map((action) => {
        const field = Object.hasOwn(tools, action.name) ? tools[action.name]?.text : undefined;

        return [
          action.name,
          (...args: ReadonlyArray<Action.Any["input"]["Type"]>) =>
            Effect.flatMap(inputOf(action, args), (input) =>
              callTool(client, url, action, field, input),
            ),
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
