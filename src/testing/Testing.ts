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
import { McpSchema } from "effect/ai";
import { Base64, Sse } from "effect/encoding";
import type * as Action from "../contract/Action.js";
import { assertOnce, projectedErrors } from "../contract/rules.js";
import { type Call, inputOf } from "../contract/call.js";
import { type BuiltIn, Refusal } from "../contract/errors.js";
import {
  defaultPath,
  type Field,
  fieldKey,
  type Lift,
  liftOf,
  type Params,
  statelessRequest,
} from "../mcp/protocol.js";
import { clientOf, type Served } from "./memory.js";

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
/**
 * The native `HttpClient`, answered in memory by `routes` instead of the network: provide
 * it to `ActionHttp.client` and to `mcpClient`. The routes are built with this layer and
 * released with its scope, without request logs. What they still require is this layer's, as
 * under `HttpRouter.serve`: a builder's services, and a per-request service no middleware of
 * theirs provides, including one a global middleware reads. The routes keep their real
 * authentication: a client sends its caller's credential. Provided around it, the test
 * program shares them. It never requires
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
  if (!Layer.isLayer(routes)) return clientOf(routes);

  return Layer.unwrap(
    Effect.gen(function* () {
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

export type { Params as McpParams } from "../mcp/protocol.js";

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

/** Where an `mcpRequest` goes, and with what headers. */
export interface McpRequestOptions {
  /**
   * The endpoint, resolved by the `HttpClient` that sends the request: relative under `layer`.
   * Defaults to `/mcp`, as `mcpClient`'s does; converting to a web `Request` needs an absolute
   * one.
   */
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
  | A["error"][number]["Type"]
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

/** One block of a tool result's content. */
type Block = McpSchema.CallToolResult["content"][number];

const textOf = (block: Block | undefined): string | undefined =>
  block?.type === "text" ? block.text : undefined;

const ToolCallReply = Schema.Union([
  Schema.Struct({ result: McpSchema.CallToolResult }),
  Schema.Struct({ error: Schema.Struct({ code: Schema.Finite, message: Schema.String }) }),
]);

const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(ToolCallReply));

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

const mediaFromBlocks = ({ name, kind, many }: Field, result: McpSchema.CallToolResult) => {
  const values = result.content.flatMap((block) =>
    block.type === kind && block._meta?.[fieldKey] === name
      ? [{ data: Base64.encode(block.data), mimeType: block.mimeType }]
      : [],
  );

  return many || values.length > 1 ? values : values[0];
};

const encodedSuccessOf = (lift: Lift, result: McpSchema.CallToolResult) => {
  const [whole] = lift.fields;

  if (whole !== undefined && whole.name === undefined) return mediaFromBlocks(whole, result);

  const { structuredContent = {} } = result;

  if (!Predicate.isObject(structuredContent)) return structuredContent;

  const lifted = new Set(lift.fields.map(({ name }) => name));

  return Object.fromEntries([
    ...Object.entries(structuredContent).filter(([key]) => !lifted.has(key)),
    ...lift.fields.flatMap((field) => {
      const value = mediaFromBlocks(field, result);

      return field.name === undefined || value === undefined ? [] : [[field.name, value] as const];
    }),
  ]);
};

const failWith = (errors: Action.Errors, text: string, otherwise: McpCallError) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.toCodecJson(Schema.Union(errors))))(
    text,
  ).pipe(
    Effect.mapError(() => otherwise),
    Effect.flatMap(Effect.fail),
  );

const callTool = (
  client: HttpClient.HttpClient,
  url: string,
  action: Action.Any,
  lift: Lift,
  input: Action.Any["input"]["Type"],
): Effect.Effect<unknown, unknown> => {
  const { name } = action;

  const other = (answer: string) =>
    new McpCallError({ message: `MCP tools/call "${name}" ${answer}` });

  return Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(action.input))(input);

    const response = yield* client.execute(
      mcpRequest("tools/call", { name, arguments: encoded }, { url }),
    );

    const text = yield* response.text;

    if (response.status !== 200) {
      return yield* failWith(Refusal.members, text, other(`answered ${response.status}: ${text}`));
    }

    const reply = replyOf(response, text);

    if (Option.isNone(reply)) return yield* Effect.fail(other(`had no reply: ${text}`));

    if ("error" in reply.value) {
      const { code, message } = reply.value.error;

      return yield* Effect.fail(other(`failed with ${code}: ${message}`));
    }

    const { result } = reply.value;

    if (result.isError === true) {
      const error = textOf(result.content.find((block) => block.type === "text")) ?? "";

      return yield* failWith(projectedErrors(action), error, other(`returned an error: ${error}`));
    }

    if (result.structuredContent === undefined && lift.rest !== undefined) {
      return yield* Effect.fail(other(`returned no structured content: ${text}`));
    }

    return yield* Schema.decodeUnknownEffect(Schema.toCodecJson(action.success))(
      encodedSuccessOf(lift, result),
    );
  });
};

/**
 * A client of an MCP endpoint served by `ActionMcp.layerHttp`, one method per action calling
 * its tool with one stateless request, as `ActionHttp.client` calls routes: the input is
 * encoded with the action's schema, and the success decoded from its structured content, each
 * media field from the blocks whose `_meta` names it, and a success that is media, or whose
 * every field is, from its blocks alone. A declared error the tool returns, the action's own
 * or a refusal, is its decoded value, and so is a refusal the endpoint's authentication
 * answers with. The argument may be omitted when `{}` is a valid input. Requires the native
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
        const lift = liftOf(action.success);

        return [
          action.name,
          (...args: ReadonlyArray<Action.Any["input"]["Type"]>) =>
            Effect.flatMap(inputOf(action, args), (input) =>
              callTool(client, url, action, lift, input),
            ),
        ];
      }),
    );
  });
}

/**
 * One stateless MCP request of `method` with `params`, as `ActionMcp.layerHttp` serves it,
 * as the native request value: the JSON-RPC envelope, the 2026-07-28 headers, `mcp-name` from
 * `params.uri` for `resources/read` and `params.name` otherwise, and the client metadata in
 * `_meta` are filled in, under any `_meta` given, such as a `progressToken`; the protocol
 * version is always the request's own. The test sends it: `HttpClient.execute` answers the
 * response as the endpoint sent it, whatever its status, and `HttpClientRequest.toWebResult`
 * gives the web `Request` a web handler or `fetch` takes, once `url` is absolute. It is for a test
 * asserting on what `mcpClient` decodes away, such as `tools/list`, a refusal's challenge, or
 * a call its types would not send.
 */
export const mcpRequest = (
  method: string,
  params: Params = {},
  { headers = {}, url = defaultPath }: McpRequestOptions = {},
): HttpClientRequest.HttpClientRequest => {
  const { headers: routingHeaders, body } = statelessRequest(method, params);

  return HttpClientRequest.post(url).pipe(
    HttpClientRequest.setHeaders(headers),
    HttpClientRequest.setHeaders(routingHeaders),
    HttpClientRequest.bodyJsonUnsafe(body),
  );
};
