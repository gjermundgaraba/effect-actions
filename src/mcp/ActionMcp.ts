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
import type * as Action from "../contract/Action.js";
import {
  assertAuthentication,
  promote,
  type Any as Authentication,
  type ProviderOf,
  type Matching,
  type RemoteRequest,
  type Required as RequiredAuthentication,
} from "../authentication/provider.js";
import { Anyone } from "../contract/rules.js";
import {
  defaultPath,
  fieldKey,
  httpProtocol,
  isMisplaced,
  type Lift,
  type Lifted,
  liftedFrom,
  liftOf,
} from "./protocol.js";
import { recordStepUp } from "../authentication/refusal.js";
import { withStderrConsole } from "../stdio/console.js";
import { bindTools, type Projection } from "../toolkit/tools.js";
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
} from "../contract/implementation.js";

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

const strictToolProjection: Projection = {
  label: "MCP tool",
  tool: (tool) => tool.annotate(Tool.Strict, true),
};

const isToolArgumentsSchema = Schema.is(McpSchema.ToolJson);

const nativeToolJsonSchema = (
  schema: Schema.Top,
  strict: boolean,
): JsonSchema.JsonSchema | undefined => {
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
      (action) =>
        !isToolArgumentsSchema(nativeToolJsonSchema(Schema.toCodecJson(action.input), true)),
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

const parameterValidationErrorOf = (error: ErasedValue) =>
  AiError.isAiError(error) && Predicate.isTagged(error.reason, "ToolParameterValidationError")
    ? error.reason
    : undefined;

const omitRequestServices = Context.omit(
  McpSchema.McpRequestContext,
  McpSchema.McpServerClient,
  HttpServerRequest.HttpServerRequest,
  References.CurrentLogLevel,
);

const registerToolsLiftingMedia = Effect.fnUntraced(function* (
  toolkit: Toolkit.Toolkit<Record<string, Tool.Any>>,
  lifts: ReadonlyMap<string, Lift>,
) {
  const registry = yield* McpServer.McpServer;

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

  const retainedServices = omitRequestServices(
    yield* Effect.context<Tool.HandlerServices<Tool.Any>>(),
  );

  const propagateInterruptOrReportInternal = (cause: Cause.Cause<ErasedValue>) => {
    const failure = Cause.findFail(cause);

    return Result.isFailure(failure) && !Cause.hasDies(cause)
      ? Effect.failCause(failure.failure)
      : Effect.logError(cause).pipe(
          Effect.andThen(Effect.provideContext(ErrorReporter.report(cause), retainedServices)),
          Effect.as(textErrorResult(nativeInternalErrorText)),
        );
  };

  const invalidParamsOrInternal = (cause: Cause.Cause<ErasedValue>) => {
    const failure = Cause.findFail(cause);

    if (Result.isSuccess(failure)) {
      const { error } = failure.success;
      const origin = Context.get(Cause.reasonAnnotations(failure.success), Toolkit.FailureOrigin);
      const invalid = origin === "parameters" ? parameterValidationErrorOf(error) : undefined;

      if (invalid !== undefined)
        return Effect.fail(new McpSchema.InvalidParams({ message: invalid.message }));
    }

    return propagateInterruptOrReportInternal(cause);
  };

  const registrations = yield* Effect.forEach(Object.entries(built.tools), ([name, tool]) =>
    Effect.gen(function* () {
      const strict = Tool.getStrictMode(tool) === true;

      const decodeOptions = {
        onExcessProperty: strict ? "error" : "ignore",
        errors: "all",
      } as const;

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
              nativeToolJsonSchema(structured, false),
            ).pipe(Effect.orDie);

      const inputSchema = yield* Schema.decodeUnknownEffect(McpSchema.ToolJson)(
        nativeToolJsonSchema(tool.parametersSchema, strict),
      ).pipe(Effect.orDie);

      const liftedFieldNames = new Set(media?.fields.map(({ name }) => name));

      const resultWithLiftedMedia = ({ encodedResult, result }: Tool.HandlerResult<Tool.Any>) => {
        if (media === undefined) {
          return new McpSchema.CallToolResult({
            isError: false,
            structuredContent: encodedResult,
            content: nativeJsonTextOf(encodedResult),
          });
        }

        const blocks = liftedFrom(media, result).map(contentBlockOf);

        if (structured === undefined) {
          return new McpSchema.CallToolResult({ isError: false, content: blocks });
        }

        const encodedRestOfStruct = Predicate.isObject(encodedResult)
          ? Object.fromEntries(
              Object.entries(encodedResult).filter(([key]) => !liftedFieldNames.has(key)),
            )
          : encodedResult;

        return new McpSchema.CallToolResult({
          isError: false,
          structuredContent: encodedRestOfStruct,
          content: [...nativeJsonTextOf(encodedRestOfStruct), ...blocks],
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
            Effect.flatMap((result) =>
              !result.isFailure
                ? Effect.succeed(resultWithLiftedMedia(result))
                : result.failureOrigin === "handler"
                  ? Effect.succeed(
                      new McpSchema.CallToolResult({
                        isError: true,
                        content: nativeJsonTextOf(result.encodedResult),
                      }),
                    )
                  : Effect.failCause(
                      Cause.annotate(
                        Cause.fail(result.result),
                        Context.make(Toolkit.FailureOrigin, result.failureOrigin ?? "result"),
                      ),
                    ),
            ),
            Effect.catchCause(invalidParamsOrInternal),
            Effect.provideContext(retainedServices),
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
      ? strictToolProjection
      : {
          ...strictToolProjection,
          handler: (run, action) => (input) =>
            action.caller === Anyone
              ? run(input)
              : recordStepUp(promote(authentication, run(input))),
        },
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

    const handlers = yield* Layer.build(binding.layer);

    yield* registerToolsLiftingMedia(binding.toolkit, lifts).pipe(
      Effect.setContext(Context.add(handlers, McpServer.McpServer, registry)),
    );
  });

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

    const method = headers["mcp-method"];

    if (method === undefined) return true;

    if (anonymousMethods.has(method)) return false;

    if (method !== "tools/call") return true;

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
