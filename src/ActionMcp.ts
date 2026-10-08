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
  References,
  Result,
  Schema,
  type Stdio,
  Stream,
} from "effect";
import { AiError, McpProtocol, McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import { type Headers, HttpRouter, HttpServerRequest } from "effect/http";
import type * as Action from "./Action.js";
import {
  assertAuthentication,
  promote,
  type Any as Authentication,
  type ProviderOf,
  type Matching,
  type RemoteRequest,
  type Required as RequiredAuthentication,
} from "./internal/authentication.js";
import { Anyone } from "./internal/actions.js";
import {
  defaultPath,
  fieldKey,
  httpProtocol,
  isMisplaced,
  type Lift,
  type Lifted,
  liftedFrom,
  liftOf,
} from "./internal/mcp.js";
import { recordStepUp } from "./internal/refusal.js";
import { logToStderr } from "./internal/console.js";
import { bindTools, type Projection } from "./internal/tools.js";
import {
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
} from "./internal/implementation.js";

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
 * One Streamable HTTP MCP endpoint: `Options`, and every native `McpServer.layerHttp` option
 * except `protocols`, `allowedOrigins` among them, with `path` defaulting to `/mcp`.
 */
export interface LayerHttpOptions<E = never, R = never, A extends Action.Any = Action.Any>
  extends Options<E, R, A>, Omit<Parameters<typeof McpServer.layerHttp>[0], "protocols" | "path"> {
  /** The endpoint's route; defaults to `/mcp`. */
  readonly path?: HttpRouter.PathInput;
  readonly authentication?: Authentication;
}

/**
 * The revisions served over stdio: 2026-07-28 and the stateful revisions hosts open stdio
 * with, newest first; a host asking for another is offered 2025-11-25. A success is sent as it
 * is on each. 2026-07-28 carries any success as `structuredContent`; the adapters of 2025-11-25
 * and 2025-06-18 carry only an object there, and list only an object-rooted `outputSchema`. A
 * success they do not structure is text alone, a string as itself.
 */
const stdioProtocols = [
  McpProtocol.v2026_07_28,
  McpProtocol.v2025_11_25,
  McpProtocol.v2025_06_18,
] as const;

/**
 * The native server supplies its own request context to every tool call, and the registry
 * it registers the tools on, the endpoint's own; over HTTP the router its own, such as the
 * request.
 */
type ToolRequestContext<R> = Exclude<R, McpSchema.McpRequestContext | McpServer.McpServer>;

type HttpToolRequestContext<R> = Exclude<ToolRequestContext<R>, HttpRouter.Provided>;

/**
 * What the native features owe, `R`, beside the registry, which the endpoint provides them,
 * so one registering through `McpServer.registerResource` owes it no host.
 */
type Features<R> = Exclude<R, McpServer.McpServer>;

/**
 * MCP has a JSON-only wire contract. Success is the encoded success as structured content,
 * and its JSON as text, but for its media, each lifted into a block of its own; declared
 * failures are returned as JSON text. The native server refuses undeclared arguments and
 * publishes closed input schemas.
 */
const projection: Projection = {
  label: "MCP tool",
  tool: (tool) => tool.annotate(Tool.Strict, true),
};

/** Whether a JSON Schema is one the native server takes for a tool's arguments. */
const isToolJson = Schema.is(McpSchema.ToolJson);

/**
 * The JSON Schema of `schema`, a JSON codec, as the native server lists it for a tool: a
 * `$ref` at its root resolved, as MCP requires an object root, and its definitions as `$defs`.
 * A strict one refuses undeclared keys.
 */
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

/**
 * Refuse, when the server is made, the actions whose input is not one object, as the root of a
 * tool's arguments must be, naming every one, reading the JSON Schema the native
 * server reads: not a union, an array, a scalar, nor `Schema.Struct({})`, which takes any value
 * but `null`, where the native server dies when the layer builds, suggesting
 * `Tool.EmptyParams`. Then refuse those holding media where no tool lifts it, as each action's
 * `Lift` says.
 */
const assertShapes = (lifted: ReadonlyArray<readonly [Action.Any, Lift]>): void => {
  const actions = lifted.map(([action]) => action);

  const inputs = actions
    .filter((action) => !isToolJson(toolJsonSchema(Schema.toCodecJson(action.input), true)))
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

/**
 * What the native server answers a call that fails other than as its contract declares: a
 * defect, an invalid success or error, or an unknown tool.
 */
const internalError = "Tool execution failed due to an internal server error.";

/** A tool's error result, `text` its one text block. */
const errorResult = (text: string) =>
  new McpSchema.CallToolResult({ isError: true, content: [{ type: "text", text }] });

/** The one text block holding `encoded`'s JSON, none for `undefined`, as the native server sends it. */
const textOf = (encoded: ErasedValue): McpSchema.CallToolResult["content"] =>
  encoded === undefined ? [] : [{ type: "text", text: JSON.stringify(encoded) }];

/** The content block a lifted media value is sent as, naming its field where it has one. */
const blockOf = ({ kind, field, value }: Lifted): McpSchema.ContentBlock => ({
  type: kind,
  data: value.data,
  mimeType: value.mimeType,
  ...(field === undefined ? {} : { _meta: { [fieldKey]: field } }),
});

/** Why a tool call's arguments failed to decode, as the native server tells it, if they did. */
const invalidParameters = (error: ErasedValue) =>
  AiError.isAiError(error) && Predicate.isTagged(error.reason, "ToolParameterValidationError")
    ? error.reason
    : undefined;

// Request services come from each call, never from the context a handler was built or
// registered in, even when that was during a request.
const omitRequestServices = Context.omit(
  McpSchema.McpRequestContext,
  McpSchema.McpServerClient,
  HttpServerRequest.HttpServerRequest,
  References.CurrentLogLevel,
);

/**
 * Register the tools of `toolkit` on the endpoint's registry, as `McpServer.registerToolkit`
 * does, lifting the media `lifts` finds in a tool's success into blocks of their own. The native
 * registration sends every success as structured content and one JSON text block, and takes
 * no option, so this one follows it: its decode options, failure classification, defect
 * scrubbing and listing, and the request services it leaves out of what it retains. A tool
 * whose action holds no media is registered as the native one would be: a test compares their
 * listings and results, not the services each call runs with.
 */
const registerTools = Effect.fnUntraced(function* (
  toolkit: Toolkit.Toolkit<Record<string, Tool.Any>>,
  lifts: ReadonlyMap<string, Lift>,
) {
  const registry = yield* McpServer.McpServer;

  // Each handler retains the context its layer was built in, but its request services.
  const built = yield* toolkit.pipe(
    Effect.updateContext((context: Context.Context<Tool.HandlersFor<Record<string, Tool.Any>>>) =>
      Context.merge(
        context,
        Context.mergeAll(
          ...Object.values(toolkit.tools).flatMap((tool) => {
            const key = Context.Service<Tool.Handler<string>>(tool.id);

            return Option.toArray(Context.getOption(context, key)).map((handler) =>
              Context.make(key, { ...handler, context: omitRequestServices(handler.context) }),
            );
          }),
        ),
      ),
    ),
  );

  // What the handlers read, erased, but what each call supplies.
  const services = omitRequestServices(yield* Effect.context<Tool.HandlerServices<Tool.Any>>());

  // Interruption propagates; anything else is logged, reported and scrubbed.
  const internalToolError = (cause: Cause.Cause<ErasedValue>) => {
    const failure = Cause.findFail(cause);

    return Result.isFailure(failure) && !Cause.hasDies(cause)
      ? Effect.failCause(failure.failure)
      : Effect.logError(cause).pipe(
          Effect.andThen(Effect.provideContext(ErrorReporter.report(cause), services)),
          Effect.as(errorResult(internalError)),
        );
  };

  // Invalid arguments are the call's error; any other failure is internal.
  const handleCause = (cause: Cause.Cause<ErasedValue>) => {
    const failure = Cause.findFail(cause);

    if (Result.isSuccess(failure)) {
      const { error } = failure.success;
      const origin = Context.get(Cause.reasonAnnotations(failure.success), Toolkit.FailureOrigin);
      const invalid = origin === "parameters" ? invalidParameters(error) : undefined;

      if (invalid !== undefined)
        return Effect.fail(new McpSchema.InvalidParams({ message: invalid.message }));
    }

    return internalToolError(cause);
  };

  const registrations = yield* Effect.forEach(Object.entries(built.tools), ([name, tool]) =>
    Effect.gen(function* () {
      const strict = Tool.getStrictMode(tool) === true;

      const decodeOptions = {
        onExcessProperty: strict ? "error" : "ignore",
        errors: "all",
      } as const;

      // A success holding media sends the rest of it as any success is sent, if any is left.
      const lift = lifts.get(name);
      const media = lift === undefined || lift.fields.length === 0 ? undefined : lift;

      const structured =
        media === undefined
          ? tool.successSchema
          : media.rest === undefined
            ? undefined
            : Schema.toCodecJson(media.rest);

      const outputSchema =
        structured === undefined
          ? undefined
          : yield* Schema.decodeUnknownEffect(McpSchema.ToolOutputJson)(
              toolJsonSchema(structured, false),
            ).pipe(Effect.orDie);

      const inputSchema = yield* Schema.decodeUnknownEffect(McpSchema.ToolJson)(
        toolJsonSchema(tool.parametersSchema, strict),
      ).pipe(Effect.orDie);

      const lifted = new Set(media?.fields.map(({ name }) => name));

      // A success as structured content and its JSON, as the native server sends it; with
      // media, the rest of its encoding so, then a block for each media value, taken from the
      // decoded success, or the blocks alone.
      const succeeded = ({ encodedResult, result }: Tool.HandlerResult<Tool.Any>) => {
        if (media === undefined) {
          return new McpSchema.CallToolResult({
            isError: false,
            structuredContent: encodedResult,
            content: textOf(encodedResult),
          });
        }

        const blocks = liftedFrom(media, result).map(blockOf);

        if (structured === undefined) {
          return new McpSchema.CallToolResult({ isError: false, content: blocks });
        }

        // Fields are lifted only from a struct without an encoding of its own, whose encoding
        // is an object keyed by them.
        const rest = Predicate.isObject(encodedResult)
          ? Object.fromEntries(Object.entries(encodedResult).filter(([key]) => !lifted.has(key)))
          : encodedResult;

        return new McpSchema.CallToolResult({
          isError: false,
          structuredContent: rest,
          content: [...textOf(rest), ...blocks],
        });
      };

      const listed = new McpSchema.Tool({
        name,
        description: Tool.getDescription(tool),
        inputSchema,
        outputSchema,
        annotations: {
          ...Context.getOption(tool.annotations, Tool.Title).pipe(
            Option.map((title) => ({ title })),
            Option.getOrUndefined,
          ),
          readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
          destructiveHint: Context.get(tool.annotations, Tool.Destructive),
          idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
          openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
        },
        _meta: Context.getOrUndefined(tool.annotations, Tool.Meta),
      });

      return {
        tool: listed,
        annotations: tool.annotations,
        handle: (payload: ErasedValue) =>
          built.handle(name, payload ?? {}, undefined, decodeOptions).pipe(
            Stream.unwrap,
            Stream.runLast,
            Effect.flatMap(Effect.fromOption),
            // A declared failure is the call's result, its JSON; any other is classified by
            // where it failed.
            Effect.flatMap((result) =>
              !result.isFailure
                ? Effect.succeed(succeeded(result))
                : result.failureOrigin === "handler"
                  ? Effect.succeed(
                      new McpSchema.CallToolResult({
                        isError: true,
                        content: textOf(result.encodedResult),
                      }),
                    )
                  : Effect.failCause(
                      Cause.annotate(
                        Cause.fail(result.result),
                        Context.make(Toolkit.FailureOrigin, result.failureOrigin ?? "result"),
                      ),
                    ),
            ),
            Effect.catchCause(handleCause),
            Effect.provideContext(services),
          ),
      };
    }),
  );

  for (const registration of registrations) {
    yield* registry.addTool(registration);
  }
});

const server = <Out, R>(
  apps: ReadonlyArray<AnyImplementation>,
  transport: Layer.Layer<Out, Cause.IllegalArgumentError, R>,
  features: Layer.Layer<never, unknown, unknown> = Layer.empty,
  authentication?: Authentication,
) => {
  const binding = bindTools(
    apps,
    authentication === undefined
      ? projection
      : {
          ...projection,
          // A protected tool's step-up refusal answers its request; a public one's is its
          // result, signed in or not, as a public route's is over HTTP.
          handler: (run, action) => (input) =>
            action.caller === Anyone
              ? run(input)
              : recordStepUp(promote(authentication, run(input))),
        },
  );

  const lifted = apps.flatMap((app) =>
    app.actions.map((action) => [action, liftOf(action.success)] as const),
  );

  assertShapes(lifted);

  const lifts = new Map(lifted.map(([{ name }, lift]) => [name, lift]));

  // Registered with only the registry and the tool handlers: the native server lays the
  // context it registers in over every call's. Each handler keeps what it was built with,
  // which, as in a `Toolkit` call, fills in only what the call's request lacks.
  const register = Effect.gen(function* () {
    const registry = yield* McpServer.McpServer;

    // The features are registered first. A native tool of an action's name would replace
    // the action's, and with it the access the endpoint's authentication decides by name.
    const claimed = registry.tools.flatMap(({ tool }) => (lifts.has(tool.name) ? [tool.name] : []));

    if (claimed.length > 0) {
      return yield* Effect.die(
        new Error(
          `Duplicate MCP tool: ${claimed.join(", ")}, claimed by an action and a native feature`,
        ),
      );
    }

    const handlers = yield* Layer.build(binding.layer);

    yield* registerTools(binding.toolkit, lifts).pipe(
      Effect.setContext(Context.add(handlers, McpServer.McpServer, registry)),
    );
  });

  // Native features provide the native registry themselves, so they register on this one
  // only when built in its graph, before the actions.
  return Layer.effectDiscard(register).pipe(
    Layer.provide(features),
    Layer.provide(transport),
    // The native registry is mutable; every endpoint/subprocess gets its own one. Only
    // the registry: handlers are provided outside it, so builders stay shared, and so are
    // the services the features need, provided around the endpoint.
    Layer.fresh,
    provideHandlers(apps),
  );
};

/**
 * What an anonymous caller of a mixed endpoint may send besides a public tool's call:
 * discovering the server and its tools, which the contracts describe, and cancelling.
 * Everything else, a native feature's listing, completion or subscription among them, and
 * any method a later revision adds, authenticates.
 */
const anonymous = new Set(["server/discover", "tools/list", "notifications/cancelled"]);

/**
 * Whether a request to an endpoint serving `actions` must authenticate before the native
 * server reads its body. An endpoint whose every tool is protected authenticates every
 * request, so a host signs in when it connects. Otherwise the request's routing headers
 * decide, which the native server refuses when they disagree with the body: discovery and a
 * call of a public tool authenticate only a caller presenting credentials, and everything
 * else authenticates, so native features are protected too. A request whose headers name
 * no public tool as it is authenticates: it fails closed.
 */
const requiresAuthentication = (actions: ReadonlyArray<Action.Any>) => {
  const open = new Set(actions.filter(({ caller }) => caller === Anyone).map(({ name }) => name));

  return (headers: Headers.Headers): boolean => {
    if (open.size === 0) return true;

    const method = headers["mcp-method"];

    if (method === undefined) return true;

    if (anonymous.has(method)) return false;

    if (method !== "tools/call") return true;

    // Tool names are ASCII, which the header carries as it is: any other value, a Base64
    // encoded one included, names no public tool.
    const name = headers["mcp-name"];

    return name === undefined || !open.has(name);
  };
};

/**
 * Where `D`, the descriptor given, is inferred, so the provider owed is that descriptor's.
 * Without one, tools `A` all public take none, even past a `D` given explicitly; protected
 * ones state theirs in `RequiredAuthentication` alone, as an absent `authentication` and the
 * one they require would intersect to `never`, reading as every option being wrong.
 */
type Inferring<D, A extends Action.Any> = [D] extends [undefined]
  ? [Protected<A>] extends [never]
    ? { readonly authentication?: undefined }
    : unknown
  : { readonly authentication?: D };

/**
 * Serve MCP tools over one Streamable HTTP endpoint, speaking MCP 2026-07-28 only.
 *
 * Protected tools need the `authentication` descriptor their contracts name, and the
 * provider `Authentication.layer` builds from it. On an endpoint of protected tools only,
 * every request authenticates before it is decoded. On a mixed endpoint, anyone may discover
 * the server, list its tools, cancel, and call a public tool; everything else authenticates
 * first, so a protected tool's description is listed to anyone but run only for its caller.
 * A call refused with `Unauthenticated`, or with `Forbidden` naming scopes, is answered with
 * its HTTP status and challenge, 401 or 403, as MCP authorization requires; any other
 * failure is a tool result. In a tool call, what middleware provides per request wins over
 * what the endpoint was built with; native `features` read only what they were built with,
 * never a request's. Never provide an identity at startup: a tool call takes its identity
 * only from the request it authenticated.
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
  | BuildServices<Holding<Member<Apps>, SelectedOf<O, Apps>>, SelectedOf<O, Apps>>
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
    McpServer.layerHttp({ ...options, path: path ?? defaultPath, protocols: [httpProtocol] }),
    features,
    authentication,
  );

  if (authentication === undefined) return transport;
  const required = requiresAuthentication(served);

  const middleware = HttpRouter.middleware(
    Effect.map(
      authentication["~provider"],
      (runtime) => (route) =>
        Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
          runtime.http(route, !required(request.headers)),
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
    McpServer.layerStdio({ ...options, protocols: stdioProtocols }),
    features,
  );

  // The native transport ends by interrupting the fiber that built it once the host closes
  // its side and the answers in flight are written. Built in a child, that is a normal end,
  // while an interruption of the program itself, such as a signal, stays one. Stdout carries
  // the protocol, so logs go to stderr.
  return Layer.launch(transport).pipe(
    logToStderr,
    Effect.forkChild,
    Effect.flatMap(Fiber.await),
    Effect.flatMap((exit) =>
      Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
        ? Effect.failCause(exit.cause)
        : Effect.void,
    ),
  );
}
