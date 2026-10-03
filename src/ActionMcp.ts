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
import type { HttpRouter } from "effect/http";
import type * as Action from "./Action.js";
import { assertKnown } from "./internal/actions.js";
import { defaultPath, httpProtocol, isJsonObject, type ToolOptions } from "./internal/mcp.js";
import { recordStepUp } from "./internal/refusal.js";
import { onStderr } from "./internal/console.js";
import { bindTools, type Projection } from "./internal/tools.js";
import {
  type ActionOf,
  type AnyImplementation,
  type BuildContext,
  type BuildError,
  type Member,
  provideHandlers,
  type RequestContext,
  type Served,
  toList,
} from "./internal/implementation.js";

/**
 * An MCP server of the actions `A`, over HTTP or stdio: every native `McpServer.layerStdio`
 * option except `protocols`, the server information, `instructions` and `extensions`, and
 * the options of each action's tool.
 */
export interface Options<A extends Action.Any = Action.Any> extends Omit<
  Parameters<typeof McpServer.layerStdio>[0],
  "protocols"
> {
  /**
   * The options of each action's tool, keyed by the action's name:
   * `{ readPage: { text: "markdown" } }`. A key no served action has is refused.
   */
  readonly tools?: ToolOptions<A>;
}

/**
 * One Streamable HTTP MCP endpoint of the actions `A`: `Options`, and every native
 * `McpServer.layerHttp` option except `protocols`, `allowedOrigins` among them, with `path`
 * defaulting to `/mcp`.
 */
export interface LayerHttpOptions<A extends Action.Any = Action.Any>
  extends Options<A>, Omit<Parameters<typeof McpServer.layerHttp>[0], "protocols" | "path"> {
  /** The endpoint's route; defaults to `/mcp`. */
  readonly path?: HttpRouter.PathInput;
}

/**
 * The revisions served over stdio: 2026-07-28 and every stateful revision a host negotiates
 * with `initialize`, newest first. A success is sent as it is on each. 2026-07-28 carries any
 * success as `structuredContent`; the adapters of 2025-11-25 and 2025-06-18 carry only an
 * object there, and list only an object-rooted `outputSchema`, and earlier ones neither, nor
 * 2024-11-05 tool hints. A success they do not structure is text alone, a string as itself.
 */
const stdioProtocols = [
  McpProtocol.v2026_07_28,
  McpProtocol.v2025_11_25,
  McpProtocol.v2025_06_18,
  McpProtocol.v2025_03_26,
  McpProtocol.v2024_11_05,
] as const;

/**
 * The options of a server of `Apps`, over HTTP and over stdio, whose `tools` the served actions
 * type. Each is read by a fixed key from a type distributed over `Apps`, so where `Apps` is a
 * helper's own type parameter, alone or spread into a list, the compiler reads the options
 * through the helper's constraint: `tools` checks the entries of the helper's own actions, and
 * takes any other name, which the call checks against the served actions and the layer build
 * against the success. A union argument takes the options of any of its members.
 */
type ServerOptions<Apps extends Served> = Apps extends unknown
  ? {
      readonly http: LayerHttpOptions<ActionOf<Member<Apps>>>;
      readonly stdio: Options<ActionOf<Member<Apps>>>;
    }
  : never;

/**
 * The native server supplies its own request context to every tool call, and over HTTP
 * the router its own, such as the request.
 */
type ToolRequestContext<R> = Exclude<R, McpSchema.McpRequestContext>;

type HttpToolRequestContext<R> = Exclude<ToolRequestContext<R>, HttpRouter.Provided>;

/**
 * MCP has a JSON-only wire contract. Success is the encoded success as structured content,
 * and its JSON as text; declared failures are returned as JSON text. The native server
 * refuses undeclared arguments and publishes closed input schemas. A step-up refusal is
 * recorded, so that under `Authentication.make` it answers the request.
 */
const projection: Projection = {
  label: "MCP tool",
  tool: (tool) => tool.annotate(Tool.Strict, true),
  handler: (run) => (input) => recordStepUp(run(input)),
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

/**
 * The text field of each tool `tools` names, by action name. A key no served action has is
 * refused, as a stale option cannot outlive its action.
 */
const textFields = (
  apps: ReadonlyArray<AnyImplementation>,
  tools: ToolOptions<Action.Any>,
): ReadonlyMap<string, string> => {
  assertKnown(
    "tools",
    Object.keys(tools),
    apps.flatMap((app) => app.actions.map((action) => action.name)),
  );

  return new Map(
    Object.entries(tools).flatMap(([name, options]) =>
      options?.text === undefined ? [] : [[name, options.text] as const],
    ),
  );
};

const server = <Out, R>(
  apps: ReadonlyArray<AnyImplementation>,
  transport: Layer.Layer<Out, Cause.IllegalArgumentError, R>,
  tools: ToolOptions<Action.Any> = {},
) => {
  const binding = bindTools(apps, projection);
  const texts = textFields(apps, tools);

  assertObjectInputs(apps);

  // Registered with only the registry and the tool handlers: the native server lays the
  // context it registers in over every call's. Each handler keeps what it was built with,
  // which, as in a `Toolkit` call, fills in only what the call's request lacks.
  const register = Effect.gen(function* () {
    const registry = yield* McpServer.McpServer;
    const handlers = yield* Layer.build(binding.layer);

    yield* McpServer.registerToolkit(binding.toolkit).pipe(
      Effect.setContext(Context.add(handlers, McpServer.McpServer, withTexts(registry, texts))),
    );
  });

  return Layer.effectDiscard(register).pipe(
    Layer.provide(transport),
    // The native registry is mutable; every endpoint/subprocess gets its own one. Only
    // the registry: handlers are provided outside it, so builders stay shared.
    Layer.fresh,
    provideHandlers(apps),
  );
};

/**
 * Serve MCP tools over one Streamable HTTP endpoint, speaking MCP 2026-07-28 only.
 *
 * An endpoint is one route: middleware provided around this layer, such as
 * authentication, covers every tool of it, tool listing included, with the normal HTTP
 * lifetime. Tools under different middleware go on endpoints of their own. Under
 * `Authentication.make`, a call refused with `Unauthenticated`, or with `Forbidden` naming
 * scopes, is answered with its HTTP status and challenge, 401 or 403, as MCP authorization
 * requires; any other failure, and every failure without it, is a tool result. What
 * middleware provides per request wins over what the endpoint was built with; still, never
 * provide an identity at startup, which a route no authentication covers serves to anyone.
 */
export function layerHttp<const Apps extends Served>(
  implementations: Apps,
  options: NoInfer<ServerOptions<Apps>["http"]>,
): Layer.Layer<
  never,
  BuildError<Member<Apps>> | Cause.IllegalArgumentError,
  | BuildContext<Member<Apps>>
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<"Requires", HttpToolRequestContext<RequestContext<Member<Apps>>>>
>;
export function layerHttp(apps: Served, { tools, ...options }: LayerHttpOptions) {
  return server(
    toList(apps),
    McpServer.layerHttp({
      ...options,
      path: options.path ?? defaultPath,
      protocols: [httpProtocol],
    }),
    tools,
  );
}

/**
 * Serve MCP tools through newline-delimited JSON-RPC on standard I/O, speaking MCP
 * 2026-07-28 or any earlier revision back to 2024-11-05, as the host negotiates: the whole
 * program of an MCP subprocess, which succeeds once the host closes its side and the calls in
 * flight, which that interrupts, have stopped. A signal interrupts it.
 *
 * Effect logs go to stderr, since stdout carries the protocol. The host supplies the
 * `Stdio` service and the identity. Arguments are tool input only and never establish
 * request identity or authority; each implementation's `before` hook runs.
 */
export function runStdio<const Apps extends Served>(
  implementations: Apps,
  options: NoInfer<ServerOptions<Apps>["stdio"]>,
): Effect.Effect<
  void,
  BuildError<Member<Apps>> | Cause.IllegalArgumentError,
  BuildContext<Member<Apps>> | Stdio.Stdio | ToolRequestContext<RequestContext<Member<Apps>>>
>;
export function runStdio(apps: Served, { tools, ...options }: Options) {
  const transport = server(
    toList(apps),
    McpServer.layerStdio({ ...options, protocols: stdioProtocols }),
    tools,
  );

  // The native transport ends by interrupting the fiber that built it once the host closes
  // its side. Built in a child, that is a normal end, while an interruption of the program
  // itself, such as a signal, stays one. Stdout carries the protocol, so logs go to stderr.
  return Layer.launch(transport).pipe(
    onStderr,
    Effect.forkChild,
    Effect.flatMap(Fiber.await),
    Effect.flatMap((exit) =>
      Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
        ? Effect.failCause(exit.cause)
        : Effect.void,
    ),
  );
}
