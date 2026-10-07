import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  JsonPointer,
  type JsonSchema,
  Layer,
  Predicate,
  Schema,
  type Stdio,
} from "effect";
import { McpProtocol, McpSchema, McpServer, Tool } from "effect/ai";
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
import { defaultPath, httpProtocol } from "./internal/mcp.js";
import { recordStepUp } from "./internal/refusal.js";
import { logToStderr } from "./internal/console.js";
import { bindTools, type Projection } from "./internal/tools.js";
import {
  type Protected,
  type ActionOf,
  type AnyImplementation,
  type BuildServices,
  type BuildError,
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
 * and its JSON as text; declared failures are returned as JSON text. The native server
 * refuses undeclared arguments and publishes closed input schemas.
 */
const projection: Projection = {
  label: "MCP tool",
  tool: (tool) => tool.annotate(Tool.Strict, true),
};

/** Whether a JSON Schema is one the native server takes for a tool's arguments. */
const isToolJson = Schema.is(McpSchema.ToolJson);

/**
 * The JSON Schema root of `schema` as the native server lists it for a tool, a `$ref` at its
 * root resolved.
 */
const rootOf = (schema: Schema.Top): JsonSchema.JsonSchema | undefined => {
  const document = Schema.toJsonSchemaDocument(Schema.toCodecJson(schema));

  const [scope, key] = Predicate.isString(document.schema.$ref)
    ? (JsonPointer.parseUriFragment(document.schema.$ref) ?? [])
    : [];

  return scope === "$defs" && key !== undefined ? document.definitions[key] : document.schema;
};

/**
 * Refuse, when the server is made, the actions of `apps` whose input is not one object, as the
 * root of a tool's arguments must be, naming every one, reading the JSON Schema the native
 * server reads: not a union, an array, a scalar, nor `Schema.Struct({})`, which takes any value
 * but `null`, where the native server dies when the layer builds, suggesting
 * `Tool.EmptyParams`.
 */
const assertShapes = (apps: ReadonlyArray<AnyImplementation>): void => {
  const inputs = apps
    .flatMap((app) => app.actions)
    .filter((action) => !isToolJson(rootOf(action.input)))
    .map(({ name }) => name);

  if (inputs.length > 0) {
    throw new Error(
      `MCP tool input must be one object with keys, such as a struct: ${inputs.join(", ")}`,
    );
  }
};

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

  assertShapes(apps);

  const names = new Set(apps.flatMap((app) => app.actions.map(({ name }) => name)));

  // Registered with only the registry and the tool handlers: the native server lays the
  // context it registers in over every call's. Each handler keeps what it was built with,
  // which, as in a `Toolkit` call, fills in only what the call's request lacks.
  const register = Effect.gen(function* () {
    const registry = yield* McpServer.McpServer;

    // The features are registered first. A native tool of an action's name would replace
    // the action's, and with it the access the endpoint's authentication decides by name.
    const claimed = registry.tools.flatMap(({ tool }) => (names.has(tool.name) ? [tool.name] : []));

    if (claimed.length > 0) {
      return yield* Effect.die(
        new Error(
          `Duplicate MCP tool: ${claimed.join(", ")}, claimed by an action and a native feature`,
        ),
      );
    }

    const handlers = yield* Layer.build(binding.layer);

    yield* McpServer.registerToolkit(binding.toolkit).pipe(
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
 * program of an MCP subprocess, which succeeds once the host closes its side and the calls in
 * flight, which that interrupts, have stopped. A signal interrupts it.
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
  // its side. Built in a child, that is a normal end, while an interruption of the program
  // itself, such as a signal, stays one. Stdout carries the protocol, so logs go to stderr.
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
