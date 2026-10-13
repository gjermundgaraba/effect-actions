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
  Predicate,
  Result,
  Schema,
  type Stdio,
} from "effect";
import { AiError, McpSchema, McpServer } from "effect/ai";
import { type Headers, HttpRouter, HttpServerRequest } from "effect/http";
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
import { Anyone, assertAuthentication, assertOnce, projectedErrors } from "../contract/rules.js";
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
  routedName,
} from "./protocol.js";
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
  type Known,
  type SelectedOf,
  type Selection,
  type Served,
  type ServedRequest,
  toList,
} from "../contract/implementation.js";

export { client, McpCallError, request } from "./client.js";

export type { Client, ClientOptions, Params, RequestOptions } from "./client.js";

/**
 * An MCP server, over HTTP or stdio: every native `McpServer.layerStdio` option except
 * `protocols`, the server information, `instructions` and `extensions`, the actions `A` that
 * are its tools, and the native features it serves beside them.
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
   * server's registry; merged beside it instead, they register on another and are not served.
   */
  readonly features?: Layer.Layer<never, E, R> | undefined;
}

/**
 * One Streamable HTTP MCP endpoint, speaking MCP 2026-07-28, 2025-11-25 or 2025-06-18, as the
 * client negotiates: `Options`, and every native `McpServer.layerHttp` option, `allowedOrigins`
 * among them, except `protocols` and `allowSessionTermination`, which are fixed, with `path`
 * defaulting to `/mcp`. A client of a 2025 revision opens a session with `initialize`, which
 * lasts until that client ends it with a DELETE, answered 204, or the process stops.
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
  readonly authentication?: Authentication;
}

type ToolRequestContext<R> = Exclude<R, McpSchema.McpRequestContext | McpServer.McpServer>;

type HttpToolRequestContext<R> = Exclude<ToolRequestContext<R>, HttpRouter.Provided>;

type Features<R> = Exclude<R, McpServer.McpServer>;

const isToolArgumentsSchema = Schema.is(McpSchema.ToolJson);

// Why: MCP requires an object root, so a top-level `$ref` is inlined, as Effect's private
// `toolJsonSchema` does for `registerToolkit`; tests/mcp/media.test.ts compares the listings.
const toolJsonSchema = (schema: Schema.Top, strict: boolean): JsonSchema.JsonSchema | undefined => {
  const document = Schema.toJsonSchemaDocument(schema, {
    onExcessProperty: strict ? "error" : "ignore",
  });

  const [scope, key] = Predicate.isString(document.schema.$ref)
    ? (JsonPointer.parseUriFragment(document.schema.$ref) ?? [])
    : [];

  const root = scope === "$defs" && key !== undefined ? document.definitions[key] : document.schema;

  return root === undefined || Object.keys(document.definitions).length === 0
    ? root
    : { ...root, $defs: document.definitions };
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
      `MCP tool input must be one object with keys, such as a struct: ${inputs.join(", ")}`,
    );
  }

  const misplaced = lifted
    .filter(([action, lift]) => isMisplaced(action, lift))
    .map(([{ name }]) => name);

  if (misplaced.length > 0) {
    throw new Error(
      `MCP media must be the success or an array of it, or a top-level field of a struct success, one, optional or a required array: ${misplaced.join(", ")}`,
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
          readOnlyHint: action.readOnly,
          destructiveHint: action.mcp.destructiveHint ?? !action.readOnly,
          idempotentHint: action.mcp.idempotentHint ?? false,
          openWorldHint: action.mcp.openWorldHint ?? true,
        },
        _meta: action.mcp._meta === undefined ? undefined : { ...action.mcp._meta },
      }),
  );

// Why: Effect's `registerToolkit` sends every success as `structuredContent` and one JSON text
// block and takes no option, so each action is registered here from its bound handler, through the
// registry's public `addTool`.
const registerTools = Effect.fnUntraced(function* (
  apps: ReadonlyArray<AnyImplementation>,
  lifts: ReadonlyMap<string, Lift>,
  authentication: Authentication | undefined,
) {
  const registry = yield* McpServer.McpServer;
  const bound = yield* acquire(apps);
  const built = yield* Effect.context<unknown>();

  const internalErrorUnlessInterrupted = (cause: Cause.Cause<ErasedValue>) => {
    const failure = Cause.findFail(cause);

    return Result.isFailure(failure) && !Cause.hasDies(cause)
      ? Effect.failCause(failure.failure)
      : Effect.logError(cause).pipe(
          Effect.andThen(ErrorReporter.report(cause)),
          Effect.as(textErrorResult(nativeInternalErrorText)),
        );
  };

  for (const [action, run] of bound) {
    const lift = lifts.get(action.name);
    const media = lift === undefined || lift.fields.length === 0 ? undefined : lift;

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

      return (value: ErasedValue) =>
        Effect.mapError(encode(value), ({ message }) =>
          AiError.make({
            module: "ActionMcp",
            method: `${action.name}.handle`,
            reason: new AiError.ToolResultEncodingError({
              toolName: action.name,
              toolResult: value,
              description: message,
            }),
          }),
        );
    };

    const encodeSuccess = encoder(action.success);
    const encodeFailure = encoder(Schema.Union(projectedErrors(action)));

    const call =
      authentication === undefined || action.caller === Anyone
        ? run
        : (input: ErasedValue) => recordStepUp(promote(authentication, run(input)));

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
        Effect.annotateCurrentSpan({ tool: action.name, parameters: payload ?? {} }).pipe(
          Effect.andThen(decode(payload ?? {})),
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
              Effect.catchCause(internalErrorUnlessInterrupted),
            ),
          ),
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
  );

  const lifted = apps.flatMap((app) =>
    app.actions.map((action) => [action, liftOf(action.success)] as const),
  );

  assertToolShapes(lifted);

  const lifts = new Map(lifted.map(([{ name }, lift]) => [name, lift]));

  const register = Effect.gen(function* () {
    const registry = yield* McpServer.McpServer;

    const namesClaimedByFeatures = registry.tools.flatMap(({ tool }) =>
      lifts.has(tool.name) ? [tool.name] : [],
    );

    if (namesClaimedByFeatures.length > 0) {
      return yield* Effect.die(
        new Error(
          `Duplicate MCP tool: ${namesClaimedByFeatures.join(", ")}, claimed by an action and a native feature`,
        ),
      );
    }

    yield* registerTools(apps, lifts, authentication);
  });

  // Why: Effect's registry is one layer, shared by a whole layer graph, so `Layer.fresh` gives each
  // endpoint its own, and the features are provided inside it, as each native helper provides that
  // layer itself. The handlers are provided outside it, so builders stay shared with the graph's
  // other surfaces.
  return Layer.effectDiscard(register).pipe(
    Layer.provide(features),
    Layer.provide(transport),
    Layer.fresh,
    provideHandlers(apps),
  );
};

const anonymousMethods = new Set(["server/discover", "tools/list", "notifications/cancelled"]);

const requiresAuthentication = (actions: ReadonlyArray<Action.Any>) => {
  const open = new Set(actions.filter(({ caller }) => caller === Anyone).map(({ name }) => name));

  return (headers: Headers.Headers): boolean => {
    if (open.size === 0) return true;

    // Why: The runtime checks the routing headers against the body of a stateless request alone.
    // A request of a session carries none it checks, so it authenticates whatever it names.
    if (headers["mcp-protocol-version"] !== httpProtocol.protocolVersion) return true;

    const method = headers["mcp-method"];

    if (method === undefined) return true;

    if (anonymousMethods.has(method)) return false;

    if (method !== "tools/call") return true;

    const header = headers["mcp-name"];
    const name = header === undefined ? undefined : routedName(header);

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
 * and lasts until that client ends it with a DELETE, answered 204, or the process stops.
 *
 * Protected tools need the `authentication` descriptor their contracts name, and the
 * provider `Authentication.layer` builds from it. On an endpoint of protected tools only,
 * every request authenticates before it is decoded. On a mixed endpoint, anyone may discover
 * the server, list its tools, cancel, and call a public tool in a 2026-07-28 request;
 * everything else authenticates first, a session's every request included, so a protected
 * tool's description is listed to anyone but run only for its caller.
 * On a Bearer endpoint, a protected tool's call refused with `Unauthenticated`, or with
 * `Forbidden` naming scopes, is answered with its HTTP status and challenge, 401 or 403, as MCP
 * authorization requires, unless its response has started; any other failure is a tool result. Claude Code connects with
 * `claude mcp add --transport http <name> <url>`. In a tool call, what middleware provides per request wins over
 * what the endpoint was built with; native `features` read only what they were built with,
 * never a request's. Never provide an identity at startup: a tool call takes its identity
 * only from the request it authenticated.
 * Guide: `docs/ActionMcp.md` in this package; in an application: `examples/mcp-tools/`.
 */
export function layerHttp<
  const Apps extends Served,
  const O extends Selection<ActionOf<Member<Apps>>> = {},
  E = never,
  R = never,
  const D extends Authentication | undefined = undefined,
>(
  implementations: Apps,
  options: LayerHttpOptions<E, R, ActionOf<Member<Apps>>> &
    O &
    NoInfer<Known<O, LayerHttpOptions<E, R, Action.Any>>> &
    NoInfer<RequiredAuthentication<SelectedOf<O, Apps>>> &
    Matching<NoInfer<SelectedOf<O, Apps>>, NoInfer<D>> &
    Inferring<D, NoInfer<SelectedOf<O, Apps>>>,
): Layer.Layer<
  never,
  | BuildError<Holding<Member<Apps>, SelectedOf<O, Apps>>, SelectedOf<O, Apps>>
  | Cause.IllegalArgumentError
  | E,
  | ServerBuildServices<Holding<Member<Apps>, SelectedOf<O, Apps>>, SelectedOf<O, Apps>>
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<
      "Requires",
      HttpToolRequestContext<RemoteRequest<Member<Apps>, SelectedOf<O, Apps>>>
    >
  | ProviderOf<D>
  | Features<R>
>;
export function layerHttp(
  apps: Served,
  { actions, features, path, authentication, ...options }: LayerHttpOptions<unknown, unknown>,
) {
  const selected = select(toList(apps), actions);
  const served = selected.flatMap((app) => app.actions);
  assertAuthentication(served, authentication);

  const transport = server(
    selected,
    McpServer.layerHttp({
      ...options,
      path: path ?? defaultPath,
      protocols,
      allowSessionTermination: true,
    }),
    features,
    authentication,
  );

  if (authentication === undefined) return transport;
  const required = requiresAuthentication(served);

  const middleware = HttpRouter.middleware(
    Effect.map(
      providerOf(authentication),
      (runtime) => (route) =>
        Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
          request.method !== "POST" || required(request.headers)
            ? runtime.http(route, false)
            : Effect.flatMap(namesItsMethod(request), (named) => runtime.http(route, named)),
        ),
    ),
  );

  return transport.pipe(Layer.provide(middleware.layer));
}

/**
 * Serve MCP tools through newline-delimited JSON-RPC on standard I/O, speaking MCP
 * 2026-07-28, 2025-11-25 or 2025-06-18, as the host negotiates: the whole
 * program of an MCP subprocess, which succeeds once the host closes its side and every call
 * in flight has been answered. A signal interrupts it.
 *
 * Effect logs go to stderr, since stdout carries the protocol. The host supplies the
 * `Stdio` service and the identity. Arguments are tool input only and never establish
 * request identity or authority; each implementation's `authorize` runs for its protected actions.
 */
export function runStdio<
  const Apps extends Served,
  const O extends Selection<ActionOf<Member<Apps>>> = {},
  E = never,
  R = never,
>(
  implementations: Apps,
  options: Options<E, R, ActionOf<Member<Apps>>> & O & NoInfer<Known<O, Options<E, R, Action.Any>>>,
): Effect.Effect<
  void,
  | BuildError<Holding<Member<Apps>, SelectedOf<O, Apps>>, SelectedOf<O, Apps>>
  | Cause.IllegalArgumentError
  | E,
  | BuildServices<Holding<Member<Apps>, SelectedOf<O, Apps>>, SelectedOf<O, Apps>>
  | Stdio.Stdio
  | ToolRequestContext<ServedRequest<Member<Apps>, SelectedOf<O, Apps>>>
  | Features<R>
>;
export function runStdio(
  apps: Served,
  { actions, features, ...options }: Options<unknown, unknown>,
) {
  const transport = server(
    select(toList(apps), actions),
    McpServer.layerStdio({ ...options, protocols }),
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
