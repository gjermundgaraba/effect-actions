import {
  Cause,
  Context,
  Effect,
  ErrorReporter,
  Exit,
  Fiber,
  JsonPointer,
  type JsonSchema,
  Layer,
  Option,
  Predicate,
  Schema,
  Stdio,
  Stream,
} from "effect";
import { AiError, McpSchema, McpServer } from "effect/ai";
import { type Headers, HttpRouter, HttpServerRequest, type HttpServerResponse } from "effect/http";
import type * as Action from "../contract/Action.js";
import {
  promote,
  providerOf,
  type Any as Authentication,
  type ProviderOf,
  type Matching,
  type RemoteRequest,
  type Required as RequiredAuthentication,
  type ServerBuildServices,
} from "../authentication/provider.js";
import { Anyone, assertAuthentication } from "../contract/caller.js";
import { projectedErrors } from "../contract/declared.js";
import { hintsOf } from "../contract/hints.js";
import { assertOnce, heldOnce } from "../contract/names.js";
import { assertNoStream, type ToolAction } from "../contract/stream.js";
import { inputParseOptions } from "../contract/call.js";
import {
  defaultPath,
  fieldKey,
  httpProtocol,
  isMisplaced,
  type Lift,
  type Lifted,
  liftedFrom,
  liftOf,
  protocols,
  routingFormsOf,
} from "./protocol.js";
import { progressNotifier } from "./progress.js";
import { recordStepUp } from "../authentication/refusal.js";
import { withStderrConsole } from "../stdio/console.js";
import {
  acquire,
  type Protected,
  type ActionOf,
  type AnyImplementation,
  type BuildServices,
  type BuildError,
  type ErasedValue,
  type Holding,
  type Member,
  provideHandlers,
  select,
  type Served,
  toList,
  toolsOf,
  type Known,
  type SelectedOf,
  type Selection,
  type ServedRequest,
} from "../contract/implementation.js";

export { client } from "./client.js";

export { McpCallError } from "./reply.js";

export { request } from "./request.js";

export type { Client, ClientOptions } from "./client.js";

export type { Params, RequestOptions } from "./request.js";

/**
 * An MCP server, over HTTP or stdio: every native `McpServer.layerStdio` option but `protocols`,
 * the server information, `instructions` and `extensions` among them, the actions `A` that are
 * its tools, and the native features it serves beside them.
 */
export interface Options<E = never, R = never, A extends Action.Any = Action.Any> extends Omit<
  Parameters<typeof McpServer.layerStdio>[0],
  "protocols"
> {
  /**
   * The actions that are tools, among the implementations' actions: `[GetUser, RenameUser]`.
   * Each keeps its implementation's authorization and builder. Defaults to every action of them.
   */
  readonly actions?: ReadonlyArray<A> | undefined;
  /**
   * Native MCP features served beside the actions' tools, such as `McpServer.resource`,
   * `McpServer.prompt` and `McpServer.toolkit` layers merged into one. They register on this
   * server's registry and run with the services they were built with, and no `authorize` runs for
   * them.
   *
   * **Gotchas**
   *
   * - Merged beside the endpoint instead of passed here, they register on another registry and are never served, without an error.
   * - A service provided to this layer itself is built again for the features alone, so a resource reads another store than the tools write: provide it around the endpoint.
   * - They never receive a request's services, so they cannot read the caller: content that depends on the caller is an action.
   */
  readonly features?: Layer.Layer<never, E, R> | undefined;
}

/**
 * One Streamable HTTP MCP endpoint: `Options`, `authentication`, `requestScoped`, and every native
 * `McpServer.layerHttp` option, `allowedOrigins` among them, except `protocols` and
 * `allowSessionTermination`, which are fixed.
 */
export interface LayerHttpOptions<E = never, R = never, A extends Action.Any = Action.Any>
  extends
    Options<E, R, A>,
    Omit<
      Parameters<typeof McpServer.layerHttp>[0],
      "protocols" | "path" | "allowSessionTermination"
    > {
  /** The endpoint's route; defaults to `/mcp`. */
  readonly path?: HttpRouter.PathInput;
  /**
   * The descriptor the protected tools' contracts name, whose provider, built by
   * `Authentication.layer`, the routes provide. On an endpoint of protected tools only, every
   * request authenticates before it is decoded; on a mixed one, anyone may discover the server,
   * list its tools, cancel, and call a public tool in a 2026-07-28 request, and everything else
   * authenticates first.
   *
   * **Gotchas**
   *
   * - A credential a request presents is still verified, on a public tool's call too: an expired or invalid one answers 401, its challenge naming `invalid_token`, on which a client refreshes it or signs in again.
   * - `tools/list` names every tool, protected ones included: serve public tools on an endpoint of their own if signed-out callers must not see the rest.
   * - A client of a 2025 revision opens a session, which on an endpoint serving a protected tool only a signed-in caller does: it signs in for every request there, a public tool's call and `tools/list` included.
   * - Every prompt and resource request needs a credential, listings included: to offer them signed out, serve them on an endpoint without protected tools.
   * - A handler that sends a notification starts the response, so a refusal after it is an `isError: true` tool result, not the 401 or 403 a client re-authorizes on: refuse in `authorize`.
   */
  readonly authentication?: Authentication;
  /**
   * Whether MCP 2026-07-28 clients may subscribe, holding a stream open for list changes and
   * resource updates. Defaults to whether `features` are given: an endpoint of actions alone
   * registers its tools once, before any client connects, and serves no resource. Pass `true`
   * where a handler changes the server through `McpServer.McpServer`.
   */
  readonly allowSubscriptions?: boolean | undefined;
  /**
   * `true` runs a server per request, as Effect's `McpServer.layerHttpRequestScoped` does, for a
   * host such as Cloudflare Workers where nothing may outlive a request. It speaks MCP 2026-07-28
   * alone, so a client that opens with `initialize` is refused; it keeps no session and takes only
   * `POST`, a `DELETE` answering 405. It has no subscriptions, so `allowSubscriptions` is ignored,
   * and native `features` send no list-change notification. `McpServer.elicit` reaches no client
   * on it, as Effect's `McpServer.layerHttpRequestScoped` says.
   */
  readonly requestScoped?: boolean | undefined;
}

type ToolRequestContext<R> = Exclude<R, McpSchema.McpRequestContext | McpServer.McpServer>;

type HttpToolRequestContext<R> = Exclude<ToolRequestContext<R>, HttpRouter.Provided>;

type Features<R> = Exclude<R, McpServer.McpServer>;

const isToolArgumentsSchema = Schema.is(McpSchema.ToolJson);

const isJson = Schema.is(Schema.Json);

const definitionsReferenced = (value: Schema.Json): ReadonlyArray<string> => {
  if (
    value === null ||
    Predicate.isString(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value)
  )
    return [];

  if (Array.isArray(value)) return value.flatMap(definitionsReferenced);

  return Object.entries(value).flatMap(([field, nested]) => {
    if (field !== "$ref") return definitionsReferenced(nested);

    const [scope, key] = Predicate.isString(nested)
      ? (JsonPointer.parseUriFragment(nested) ?? [])
      : [];

    return scope === "$defs" && key !== undefined ? [key] : [];
  });
};

// Why: MCP requires an object root, so a top-level `$ref` is inlined, and the inlined root's
// definition is dropped unless something still refers to it (a recursive root, or one used again
// inside itself), as Effect's private `toolJsonSchema` does for `registerToolkit` from 4.0.6;
// tests/mcp/media.test.ts compares the listings.
const toolJsonSchema = (schema: Schema.Top, strict: boolean): JsonSchema.JsonSchema | undefined => {
  const document = Schema.toJsonSchemaDocument(schema, {
    onExcessProperty: strict ? "error" : "ignore",
  });

  const [scope, key] = Predicate.isString(document.schema["$ref"])
    ? (JsonPointer.parseUriFragment(document.schema["$ref"]) ?? [])
    : [];

  const inlined = scope === "$defs" && key !== undefined ? key : undefined;

  const root = inlined === undefined ? document.schema : document.definitions[inlined];

  if (root === undefined) return undefined;

  const definitions =
    inlined !== undefined &&
    ![root, ...Object.values(document.definitions)]
      .flatMap((schema) => (isJson(schema) ? definitionsReferenced(schema) : []))
      .includes(inlined)
      ? Object.fromEntries(
          Object.entries(document.definitions).filter(([name]) => name !== inlined),
        )
      : document.definitions;

  return Object.keys(definitions).length === 0 ? root : { ...root, $defs: definitions };
};

const assertToolShapes = (lifted: ReadonlyArray<readonly [Action.Any, Lift]>): void => {
  const actions = lifted.map(([action]) => action);

  const inputs = actions
    .filter(
      (action) => !isToolArgumentsSchema(toolJsonSchema(Schema.toCodecJson(action.input), true)),
    )
    .map(({ name }) => name);

  if (inputs.length > 0) {
    throw new Error(
      `MCP tool input must be one object with keys, such as a struct: ${inputs.join(", ")} (wrap a union, an array or a scalar in a field, omit input for no arguments, or leave the action out of actions)`,
    );
  }

  const misplaced = lifted
    .filter(([action, lift]) => isMisplaced(action, lift))
    .map(([{ name }]) => name);

  if (misplaced.length > 0) {
    throw new Error(
      `MCP media must be the success or an array of it, or a top-level field of a struct success, one, optional or a required array: ${misplaced.join(", ")} (make the image such a field, or give an optional array as a required one, empty when absent; an image in input or an error is not served over MCP, so leave that action out of actions)`,
    );
  }
};

const nativeInternalErrorText = "Tool execution failed due to an internal server error.";

const textErrorResult = (text: string) =>
  new McpSchema.CallToolResult({ isError: true, content: [{ type: "text", text }] });

const nativeJsonTextOf = (encoded: ErasedValue): McpSchema.CallToolResult["content"] =>
  encoded === undefined ? [] : [{ type: "text", text: JSON.stringify(encoded) }];

const contentBlockOf = ({ kind, field, value }: Lifted): McpSchema.ContentBlock => ({
  type: kind,
  data: value.data,
  mimeType: value.mimeType,
  ...(field === undefined ? {} : { _meta: { [fieldKey]: field } }),
});

const toolOf = (action: Action.Any, outputSchema: McpSchema.Tool["outputSchema"]) =>
  Effect.map(
    Schema.decodeUnknownEffect(McpSchema.ToolJson)(
      toolJsonSchema(Schema.toCodecJson(action.input), true),
    ),
    (inputSchema) =>
      new McpSchema.Tool({
        name: action.name,
        description: action.description,
        inputSchema,
        outputSchema,
        annotations: {
          ...(action.mcp.title === undefined ? {} : { title: action.mcp.title }),
          ...hintsOf(action),
        },
        _meta: action.mcp._meta === undefined ? undefined : { ...action.mcp._meta },
      }),
  );

// Why: Effect's `registerToolkit` sends every success as `structuredContent` and one JSON text
// block and takes no option, so each action is registered here from its bound handler, through the
// registry's public `addTool`.
const registerTools = Effect.fnUntraced(function* (
  apps: ReadonlyArray<AnyImplementation>,
  authentication: Authentication | undefined,
) {
  const registry = yield* McpServer.McpServer;
  const bound = yield* acquire(apps);
  const built = yield* Effect.context<unknown>();

  const internalError = (cause: Cause.Cause<ErasedValue>) =>
    Effect.logError(cause).pipe(
      Effect.andThen(ErrorReporter.report(cause)),
      Effect.as(textErrorResult(nativeInternalErrorText)),
    );

  const internalErrorOnDefect = (cause: Cause.Cause<McpSchema.InvalidParams>) =>
    Cause.hasDies(cause) ? internalError(cause) : Effect.failCause(cause);

  for (const [action, run] of bound) {
    const lift = liftOf(action.success);
    const media = lift.fields.length === 0 ? undefined : lift;

    const structured =
      media === undefined
        ? Schema.toCodecJson(action.success)
        : media.rest === undefined
          ? undefined
          : Schema.toCodecJson(media.rest);

    const outputSchema =
      structured === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(McpSchema.ToolOutputJson)(
            toolJsonSchema(structured, false),
          ).pipe(Effect.orDie);

    const tool = yield* toolOf(action, outputSchema).pipe(Effect.orDie);
    const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(action.input), inputParseOptions);

    const encoder = (schema: Schema.Top) => {
      const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(schema));

      return (value: ErasedValue) => Effect.orDie(encode(value));
    };

    const encodeSuccess = encoder(action.success);
    const encodeFailure = encoder(Schema.Union(projectedErrors(action)));

    const reported = (input: ErasedValue) =>
      action.progress === undefined
        ? run(input)
        : Effect.flatMap(progressNotifier(registry.notifications, action.progress), (sink) =>
            run(input, sink),
          );

    const call =
      authentication === undefined || action.caller === Anyone
        ? reported
        : (input: ErasedValue) => recordStepUp(promote(authentication, reported(input)));

    const liftedFieldNames = new Set(media?.fields.map(({ name }) => name));

    const resultOf = (encoded: ErasedValue, success: ErasedValue) => {
      if (media === undefined) {
        // Why: A success is sent as it encodes, a number, a string, an array or `null` included,
        // never wrapped in an object and never left out. A Python SDK release before the fix
        // of python-sdk#3345 reads a `null` `structuredContent` as missing, which is the SDK's
        // bug.
        return new McpSchema.CallToolResult({
          isError: false,
          structuredContent: encoded,
          content: nativeJsonTextOf(encoded),
        });
      }

      const blocks = liftedFrom(media, success).map(contentBlockOf);

      if (structured === undefined) {
        return new McpSchema.CallToolResult({ isError: false, content: blocks });
      }

      const encodedRestOfStruct = Predicate.isObject(encoded)
        ? Object.fromEntries(Object.entries(encoded).filter(([key]) => !liftedFieldNames.has(key)))
        : encoded;

      return new McpSchema.CallToolResult({
        isError: false,
        structuredContent: encodedRestOfStruct,
        content: [...nativeJsonTextOf(encodedRestOfStruct), ...blocks],
      });
    };

    yield* registry.addTool({
      tool,
      annotations: Context.empty(),
      handle: (payload: ErasedValue) =>
        // Why: a tool's arguments stay off its span, as HTTP keeps a body off its own: they
        // may hold a credential or a `Schema.Redacted` value, which a trace exports as it is.
        Effect.annotateCurrentSpan({ tool: action.name }).pipe(
          Effect.andThen(() => decode(payload ?? {})),
          Effect.mapError(
            ({ message }) =>
              new McpSchema.InvalidParams({
                message: new AiError.ToolParameterValidationError({
                  toolName: action.name,
                  description: message,
                }).message,
              }),
          ),
          Effect.flatMap((input) =>
            call(input).pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  Effect.map(
                    encodeFailure(error),
                    (encoded) =>
                      new McpSchema.CallToolResult({
                        isError: true,
                        content: nativeJsonTextOf(encoded),
                      }),
                  ),
                onSuccess: (success) =>
                  Effect.map(encodeSuccess(success), (encoded) => resultOf(encoded, success)),
              }),
            ),
          ),
          Effect.catchCause(internalErrorOnDefect),
          // Why: A call runs over what the endpoint was built with, its startup services and the
          // handlers' builds, and what the request provides wins, as a native toolkit handler's
          // context does.
          Effect.updateContext((request: Context.Context<McpSchema.McpRequestContext>) =>
            Context.merge(built, request),
          ),
        ),
    });
  }
});

const server = <Out, R>(
  apps: ReadonlyArray<AnyImplementation>,
  transport: Layer.Layer<Out, Cause.IllegalArgumentError, R>,
  features: Layer.Layer<never, unknown, unknown> = Layer.empty,
  authentication?: Authentication,
) => {
  assertOnce(
    "MCP tool",
    apps.flatMap((app) => app.actions),
    heldOnce,
  );
  assertNoStream(apps.flatMap((app) => app.actions));

  const lifted = apps.flatMap((app) =>
    app.actions.map((action) => [action, liftOf(action.success)] as const),
  );

  assertToolShapes(lifted);

  const names = new Set(lifted.map(([{ name }]) => name));

  const register = Effect.gen(function* () {
    const registry = yield* McpServer.McpServer;

    const namesClaimedByFeatures = registry.tools.flatMap(({ tool }) =>
      names.has(tool.name) ? [tool.name] : [],
    );

    if (namesClaimedByFeatures.length > 0) {
      return yield* Effect.die(
        new Error(
          `Duplicate MCP tool: ${namesClaimedByFeatures.join(", ")}, claimed by an action and a native feature (rename the native tool, or leave the action out of actions)`,
        ),
      );
    }

    yield* registerTools(apps, authentication);
  });

  // Why: Effect's registry is one layer, shared by a whole layer graph, so `Layer.fresh` gives each
  // endpoint its own, and the features are provided inside it, as each native helper provides that
  // layer itself. The handlers' builders are provided outside it, so they stay shared with the
  // graph's other surfaces.
  return Layer.effectDiscard(register).pipe(
    Layer.provide(features),
    Layer.provide(transport),
    Layer.fresh,
    provideHandlers(apps),
  );
};

const anonymousMethods = new Set(["server/discover", "tools/list", "notifications/cancelled"]);

const requiresAuthentication = (actions: ReadonlyArray<Action.Any>) => {
  // Why: The runtime routes a 2026-07-28 request by its `Mcp-Name` decoded, a name as sent or
  // base64-encoded between `=?base64?` and `?=`, so a public tool's name is admitted in either form.
  // An action's name is plain ASCII, whose standard encoding is one string: any other fails closed.
  const open = new Set(
    actions.filter(({ caller }) => caller === Anyone).flatMap(({ name }) => routingFormsOf(name)),
  );

  return (headers: Headers.Headers): boolean => {
    if (open.size === 0) return true;

    // Why: The runtime checks the routing headers against the body of a stateless request alone.
    // A request of a session carries none it checks, so it authenticates whatever it names.
    if (headers["mcp-protocol-version"] !== httpProtocol.protocolVersion) return true;

    const method = headers["mcp-method"];

    if (method === undefined) return true;

    if (anonymousMethods.has(method)) return false;

    if (method !== "tools/call") return true;

    const name = headers["mcp-name"];

    return name === undefined || !open.has(name);
  };
};

// Why: The runtime takes an `initialize` as the opening of a session whatever its headers say, the
// one request whose routing headers it does not check. So a request admitted signed out names its
// header's method in its body too. One that does not parse is the runtime's to refuse.
const namesItsMethod = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.match(request.json, {
    onFailure: () => true,
    onSuccess: (body) =>
      !Predicate.hasProperty(body, "method") || body.method === request.headers["mcp-method"],
  });

// Why: The runtime answers a body it cannot read as one that is not JSON, a `-32700` in a 200, so
// one over `HttpServerRequest.MaxBodySize` read first fails the request as itself: Effect's 413
// from 4.0.6, and before it the closed connection. The runtime then reads the text read here.
const readsItsBody = <E, R>(route: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    request.method === "POST" ? Effect.andThen(request.text, route) : route,
  );

// Why: Protected tools without a descriptor get `unknown`, leaving `RequiredAuthentication` to
// demand theirs. `{ authentication?: undefined }` would intersect with that demand to `never`, and
// the error would read as every option being wrong.
type Inferring<D, A extends Action.Any> = [D] extends [undefined]
  ? [Protected<A>] extends [never]
    ? { readonly authentication?: undefined }
    : unknown
  : { readonly authentication?: D };

/**
 * Serve MCP tools over one Streamable HTTP endpoint, speaking MCP 2026-07-28, 2025-11-25 or
 * 2025-06-18, as the client negotiates. A 2026-07-28 request stands alone; a client of a 2025
 * revision opens a session with `initialize`, which holds what it sent there and no identity,
 * and lasts until that client ends it with a DELETE, answered 204, or the process stops. Protected
 * tools need `authentication`; for a serverless host, see `requestScoped`. In a tool call, what
 * middleware provides per request wins over what the endpoint was built with.
 * Guide: `docs/ActionMcp.md` in this package; in an application: `examples/mcp-tools/`.
 *
 * **Gotchas**
 *
 * - A success is `isError: false` with `structuredContent` its JSON and the same JSON as one text block, both `null` for an action without `success`; an `Action.Image` field is left out of `structuredContent` and its text, its block following them, and a success of images alone has no `structuredContent`.
 * - A declared error is an `isError: true` tool result in a 200 holding its JSON as one text block, with no `structuredContent`; a refusal is answered as `Action.Unauthenticated` and `Action.Forbidden` say.
 * - An action declaring `progress` sends each value as `notifications/progress` on the `progressToken` its call's `_meta` carries, before the result: `progress` counts from 1, `message` is the value's JSON and `_meta["effect-actions/progress"]` the value; a call without a token gets none.
 * - Arguments that do not decode never reach the handler: an `isError: true` result in a 200, text `Invalid parameters for tool '<name>': …`, or for a 2025-06-18 client a JSON-RPC error.
 * - A defect, an undeclared failure, or a success or an error that does not encode is `isError: true`, text `Tool execution failed due to an internal server error.`: the cause goes to the log and to the call's `ErrorReporter`s, never to the client.
 * - An unknown tool is a JSON-RPC error `-32602` in a 200; a body that is not JSON a JSON-RPC error `-32700` in a 200; a `Content-Type` missing or not JSON an empty 415; another HTTP method an empty 405 with `Allow: POST, DELETE`, `Allow: POST` where `requestScoped`, or the 401 of an endpoint with authentication when signed out.
 * - A 2025-11-25 or 2025-06-18 client gets `structuredContent` only for a success that is an object: any other success arrives as its text block alone, a string unquoted.
 * - A client asking for an earlier revision, such as 2025-03-26, is offered 2025-11-25, so a client speaking only that earlier one cannot connect.
 * - A request body is read whole, however large, and a 2025 session holds what its `initialize` sent until it ends, so an oversized `initialize` costs memory for that long: limit bodies as `ActionHttp.layer` says.
 */
export function layerHttp<
  const Apps extends Served,
  const O extends Selection<ToolAction<ActionOf<Member<Apps>>>> = {},
  E = never,
  R = never,
  const D extends Authentication | undefined = undefined,
>(
  implementations: Apps,
  options: LayerHttpOptions<E, R, ToolAction<ActionOf<Member<Apps>>>> &
    O &
    NoInfer<Known<O, LayerHttpOptions<E, R, Action.Any>>> &
    NoInfer<RequiredAuthentication<ToolAction<SelectedOf<O, Apps>>>> &
    Matching<NoInfer<ToolAction<SelectedOf<O, Apps>>>, NoInfer<D>> &
    Inferring<D, NoInfer<ToolAction<SelectedOf<O, Apps>>>>,
): Layer.Layer<
  never,
  | BuildError<
      Holding<Member<Apps>, ToolAction<SelectedOf<O, Apps>>>,
      ToolAction<SelectedOf<O, Apps>>
    >
  | Cause.IllegalArgumentError
  | E,
  | ServerBuildServices<
      Holding<Member<Apps>, ToolAction<SelectedOf<O, Apps>>>,
      ToolAction<SelectedOf<O, Apps>>
    >
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<
      "Requires",
      HttpToolRequestContext<RemoteRequest<Member<Apps>, ToolAction<SelectedOf<O, Apps>>>>
    >
  | ProviderOf<D>
  | Features<R>
>;
export function layerHttp(
  apps: Served,
  {
    actions,
    features,
    path = defaultPath,
    authentication,
    requestScoped,
    allowSubscriptions = features !== undefined,
    ...options
  }: LayerHttpOptions<unknown, unknown>,
) {
  const selected = toolsOf(select(toList(apps), actions), actions);
  const served = selected.flatMap((app) => app.actions);
  assertAuthentication(served, authentication);

  const transport = server(
    selected,
    requestScoped === true
      ? McpServer.layerHttpRequestScoped({ ...options, path, protocols: [httpProtocol] })
      : McpServer.layerHttp({
          ...options,
          path,
          protocols,
          allowSessionTermination: true,
          allowSubscriptions,
        }),
    features,
    authentication,
  );

  if (authentication === undefined) {
    return transport.pipe(Layer.provide(HttpRouter.middleware(readsItsBody).layer));
  }

  const required = requiresAuthentication(served);

  const middleware = HttpRouter.middleware(
    Effect.map(
      providerOf(authentication),
      (runtime) => (route) =>
        Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
          request.method !== "POST" || required(request.headers)
            ? runtime.http(readsItsBody(route), false)
            : Effect.flatMap(namesItsMethod(request), (named) =>
                runtime.http(readsItsBody(route), named),
              ),
        ),
    ),
  );

  return transport.pipe(Layer.provide(middleware.layer));
}

const isJsonLine = (line: string): boolean =>
  Option.isSome(Schema.decodeOption(Schema.fromJsonString(Schema.Json))(line));

// Why: From Effect 4.0.6 the stdio transport's parser fails on a line that is not JSON, and its
// retry drops what else that read held, so a request after the line went unanswered. Such a
// line, and a blank one, never reaches it: the lines after it are answered on every 4.0 patch.
const jsonLinesOnly = Layer.effect(
  Stdio.Stdio,
  Effect.map(Stdio.Stdio, (stdio) =>
    Stdio.make({
      ...stdio,
      stdin: stdio.stdin.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.filter(isJsonLine),
        Stream.map((line) => `${line}\n`),
        Stream.encodeText,
      ),
    }),
  ),
);

/**
 * Serve MCP tools through newline-delimited JSON-RPC on standard I/O, speaking MCP
 * 2026-07-28, 2025-11-25 or 2025-06-18, as the host negotiates: the whole
 * program of an MCP subprocess, which succeeds once the host closes its side and every call
 * in flight has been answered. A signal interrupts it. Its own Effect logs and `Console` output
 * go to stderr, since stdout carries the protocol. The host supplies the `Stdio` service, and
 * provides the identity around `runStdio`; arguments are tool input only and never establish
 * request identity or authority, and each implementation's `authorize` runs for its protected
 * actions. Its tool results, and how it answers each revision and an earlier one asked for, are
 * `layerHttp`'s.
 *
 * **Gotchas**
 *
 * - A line that is not JSON goes unanswered, with no `-32700` as over HTTP, and the lines after it are still answered.
 * - The layers provided around it log to stdout, among the protocol's lines: apply `ActionCli.logToStderr` to the program, last, as its JSDoc says.
 */
export function runStdio<
  const Apps extends Served,
  const O extends Selection<ToolAction<ActionOf<Member<Apps>>>> = {},
  E = never,
  R = never,
>(
  implementations: Apps,
  options: Options<E, R, ToolAction<ActionOf<Member<Apps>>>> &
    O &
    NoInfer<Known<O, Options<E, R, Action.Any>>>,
): Effect.Effect<
  void,
  | BuildError<
      Holding<Member<Apps>, ToolAction<SelectedOf<O, Apps>>>,
      ToolAction<SelectedOf<O, Apps>>
    >
  | Cause.IllegalArgumentError
  | E,
  | BuildServices<
      Holding<Member<Apps>, ToolAction<SelectedOf<O, Apps>>>,
      ToolAction<SelectedOf<O, Apps>>
    >
  | Stdio.Stdio
  | ToolRequestContext<ServedRequest<Member<Apps>, ToolAction<SelectedOf<O, Apps>>>>
  | Features<R>
>;
export function runStdio(
  apps: Served,
  { actions, features, ...options }: Options<unknown, unknown>,
) {
  const transport = server(
    toolsOf(select(toList(apps), actions), actions),
    McpServer.layerStdio({ ...options, protocols }).pipe(Layer.provide(jsonLinesOnly)),
    features,
  );

  // Why: The native transport ends by interrupting the fiber that built it, once the host closes
  // its side and the answers in flight are written. Built in a child, that end is a success, and an
  // interruption of the program itself, such as a signal, stays an interruption.
  return Layer.launch(transport).pipe(
    withStderrConsole,
    Effect.forkChild,
    Effect.flatMap(Fiber.await),
    Effect.flatMap((exit) =>
      Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
        ? Effect.failCause(exit.cause)
        : Effect.void,
    ),
  );
}
