import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  JsonPointer,
  Layer,
  Option,
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
import { defaultPath, httpProtocol, isJsonObject } from "./internal/mcp.js";
import { recordStepUp } from "./internal/refusal.js";
import { logToStderr } from "./internal/console.js";
import { bindTools, type Projection } from "./internal/tools.js";
import {
  type Protected,
  type ActionOf,
  type AnyImplementation,
  type BuildContext,
  type BuildError,
  type Holding,
  type Member,
  provideHandlers,
  select,
  type Known,
  type Selected,
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
 * Refuse an action whose input is not one object, as the JSON Schema root of a tool's
 * arguments must be: not a union, an array, a scalar, nor `Schema.Struct({})`, which takes any
 * value but `null`. It reads the JSON Schema the native server reads, a `$ref` at its root
 * resolved, so it refuses what the native server would, but naming every such action, where
 * the native server dies when the layer builds, suggesting `Tool.EmptyParams`.
 */
const assertObjectInputs = (apps: ReadonlyArray<AnyImplementation>): void => {
  const refused = apps
    .flatMap((app) => app.actions)
    .filter((action) => {
      const { schema, definitions } = Schema.toJsonSchemaDocument(Schema.toCodecJson(action.input));

      const [scope, key] = Predicate.isString(schema.$ref)
        ? (JsonPointer.parseUriFragment(schema.$ref) ?? [])
        : [];

      return !isToolJson(scope === "$defs" && key !== undefined ? definitions[key] : schema);
    })
    .map(({ name }) => name);

  if (refused.length > 0) {
    throw new Error(
      `MCP tool input must be one object with keys, such as a struct: ${refused.join(", ")}`,
    );
  }
};

/** The native tool registry. */
type Registry = McpServer.McpServer["Service"];

/** What the native registry takes for one tool: its listing, and what a call of it runs. */
type Registration = Parameters<Registry["addTool"]>[0];

/** The properties of a listed output schema, which a text field must be one of. */
const decodeListed = Schema.decodeUnknownOption(
  Schema.Struct({ properties: Schema.Record(Schema.String, Schema.Json) }),
);

/**
 * `tool` listing no output schema, for a success sent as text. Its text field `field` must
 * be a top-level property of the success's listed schema; any other field fails the layer
 * build rather than name a field no success holds.
 */
const listedAsText = (tool: McpSchema.Tool, field: string): Effect.Effect<McpSchema.Tool> => {
  const listed = decodeListed(tool.outputSchema);

  if (Option.isNone(listed) || !Object.hasOwn(listed.value.properties, field)) {
    return Effect.die(
      `MCP tool '${tool.name}' cannot send '${field}' as text: it is not a top-level property of its success`,
    );
  }

  const { outputSchema: _, ...listing } = tool;

  // The native McpSchema.Tool, a Schema.Class, rebuilt from its own fields but outputSchema,
  // as McpServer.addTool rebuilds it: the constructor restores the prototype and validates them.
  return Effect.succeed(new McpSchema.Tool(listing));
};

/**
 * A success as text alone, without structured content: one whose text field holds a string as
 * two text blocks, the string once, raw, then the JSON of the rest; any other as the JSON of
 * the whole, the native text. A host preferring structured content has none, so it shows the
 * text. An error is the native result.
 */
const textResult = (result: McpSchema.CallToolResult, field: string): McpSchema.CallToolResult => {
  if (result.isError === true) return result;

  const { structuredContent: structured, ...native } = result;
  const whole: Schema.JsonObject = isJsonObject(structured) ? structured : {};
  const { [field]: detached, ...rest } = whole;

  return new McpSchema.CallToolResult({
    ...native,
    content: Predicate.isString(detached)
      ? [
          { type: "text", text: detached },
          { type: "text", text: JSON.stringify(rest) },
        ]
      : native.content,
  });
};

/** A tool's registration whose success is sent as text, its text field `field` raw. */
const withText = (registration: Registration, field: string): Effect.Effect<Registration> =>
  Effect.map(listedAsText(registration.tool, field), (tool) => ({
    ...registration,
    tool,
    handle: (payload) =>
      Effect.map(registration.handle(payload), (result) =>
        Predicate.isTagged(result, "InputRequired") ? result : textResult(result, field),
      ),
  }));

/**
 * `registry`, registering the tool of each action `texts` names with that text field. The
 * native `registerToolkit` registers every tool through `addTool`, and builds each listing
 * and result, always with the whole success as structured content; a text field's tool is
 * registered without it, so decoding, failures and defects stay native.
 */
const withTexts = (registry: Registry, texts: ReadonlyMap<string, string>): Registry => ({
  ...registry,
  addTool: (registration) => {
    const field = texts.get(registration.tool.name);

    return field === undefined
      ? registry.addTool(registration)
      : Effect.flatMap(withText(registration, field), registry.addTool);
  },
});

/** The text hint of each of `apps`' actions that has one, by action name. */
const textFields = (apps: ReadonlyArray<AnyImplementation>): ReadonlyMap<string, string> =>
  new Map(
    apps.flatMap((app) =>
      app.actions.flatMap(({ name, hints }) =>
        hints.text === undefined ? [] : [[name, hints.text] as const],
      ),
    ),
  );

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
            action.auth === "public"
              ? run(input)
              : recordStepUp(promote(authentication, run(input))),
        },
  );

  const texts = textFields(apps);

  assertObjectInputs(apps);

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
        `Duplicate MCP tool: ${claimed.join(", ")}, claimed by an action and a native feature`,
      );
    }

    const handlers = yield* Layer.build(binding.layer);

    yield* McpServer.registerToolkit(binding.toolkit).pipe(
      Effect.setContext(Context.add(handlers, McpServer.McpServer, withTexts(registry, texts))),
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
  const open = new Set(actions.filter(({ auth }) => auth === "public").map(({ name }) => name));

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
  E = never,
  R = never,
  const O extends Selection<ActionOf<Member<Apps>>> = {},
  const D extends Authentication | undefined = undefined,
>(
  implementations: Apps,
  options: LayerHttpOptions<E, R, ActionOf<Member<Apps>>> &
    O &
    NoInfer<Known<O, LayerHttpOptions<E, R, Action.Any>>> &
    NoInfer<RequiredAuthentication<Selected<O, ActionOf<Member<Apps>>>>> &
    Matching<NoInfer<Selected<O, ActionOf<Member<Apps>>>>, NoInfer<D>> &
    Inferring<D, NoInfer<Selected<O, ActionOf<Member<Apps>>>>>,
): Layer.Layer<
  never,
  | BuildError<
      Holding<Member<Apps>, Selected<O, ActionOf<Member<Apps>>>>,
      Selected<O, ActionOf<Member<Apps>>>
    >
  | Cause.IllegalArgumentError
  | E,
  | BuildContext<
      Holding<Member<Apps>, Selected<O, ActionOf<Member<Apps>>>>,
      Selected<O, ActionOf<Member<Apps>>>
    >
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<
      "Requires",
      HttpToolRequestContext<RemoteRequest<Member<Apps>, Selected<O, ActionOf<Member<Apps>>>>>
    >
  | ProviderOf<D>
  | R
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
  E = never,
  R = never,
  const O extends Selection<ActionOf<Member<Apps>>> = {},
>(
  implementations: Apps,
  options: Options<E, R, ActionOf<Member<Apps>>> & O & NoInfer<Known<O, Options<E, R, Action.Any>>>,
): Effect.Effect<
  void,
  | BuildError<
      Holding<Member<Apps>, Selected<O, ActionOf<Member<Apps>>>>,
      Selected<O, ActionOf<Member<Apps>>>
    >
  | Cause.IllegalArgumentError
  | E,
  | BuildContext<
      Holding<Member<Apps>, Selected<O, ActionOf<Member<Apps>>>>,
      Selected<O, ActionOf<Member<Apps>>>
    >
  | Stdio.Stdio
  | ToolRequestContext<ServedRequest<Member<Apps>, Selected<O, ActionOf<Member<Apps>>>>>
  | R
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
