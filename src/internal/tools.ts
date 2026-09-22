import { Effect, JsonPointer, Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import type * as Action from "../Action.js";
import { projectedErrors } from "./actions.js";
import {
  type Before,
  dispatch,
  type AnyImplementation,
  type ErasedValue,
  type Handlers,
} from "./implementation.js";

/** What a tool surface binds around the implementations it projects, erased. */
export interface ToolOptions {
  readonly errors: ReadonlyArray<Action.Codec> | undefined;
  readonly before: Before<unknown> | undefined;
}

/** An implementation/action pair exposed to a tool transport. */
interface ToolEntry {
  readonly app: AnyImplementation;
  readonly action: ToolAction;
}

/** A served implementation and its tool-enabled actions. */
interface ToolApp {
  readonly app: AnyImplementation;
  readonly actions: ReadonlyArray<ToolAction>;
}

/** Native tools and their acquired action handlers, with dynamic names erased. */
interface BoundTools {
  readonly toolkit: Toolkit.Toolkit<Record<string, Tool.Any>>;
  readonly layer: Layer.Layer<Tool.HandlersFor<Record<string, Tool.Any>>, unknown, unknown>;
}

type ToolAction = Action.Any & { readonly mcp: Exclude<Action.Any["mcp"], false> };

const isToolAction = (action: Action.Any): action is ToolAction => action.mcp !== false;

/** Only tool-enabled groups are acquired; each implementation appears once. */
const toolApps = (apps: ReadonlyArray<AnyImplementation>): ReadonlyArray<ToolApp> =>
  apps.flatMap((app) => {
    const actions = app.group.actions.filter(isToolAction);

    return actions.length === 0 ? [] : [{ app, actions }];
  });

/** Flatten the projected contracts only after deciding which groups are served. */
const entries = (apps: ReadonlyArray<ToolApp>): ReadonlyArray<ToolEntry> =>
  apps.flatMap(({ app, actions }) => actions.map((action) => ({ app, action })));

/** Fail before acquiring handlers when two exposed tools share a name. */
const assertDistinctToolNames = (tools: ReadonlyArray<ToolEntry>): void => {
  const names = new Set<string>();

  for (const { action } of tools) {
    const name = action.mcp.name;

    if (names.has(name)) throw new Error(`Duplicate MCP tool: ${name}`);
    names.add(name);
  }
};

const annotate = (tool: Tool.Any, mcp: Exclude<Action.Any["mcp"], false>) =>
  tool
    .annotate(Tool.Readonly, mcp.readOnly)
    .annotate(Tool.Destructive, mcp.destructive)
    .annotate(Tool.Idempotent, mcp.idempotent)
    .annotate(Tool.OpenWorld, mcp.openWorld);

/**
 * A native Effect AI tool. Its schemas retain action transforms and its result
 * is the action result itself, rather than an MCP response envelope.
 */
const nativeTool = (action: ToolEntry["action"], errors: ReadonlyArray<Action.Codec>): Tool.Any =>
  annotate(
    Tool.make(action.mcp.name, {
      description: action.description,
      parameters: action.input,
      success: action.success,
      failure: Schema.Union(errors),
      failureMode: "return",
    }),
    action.mcp,
  );

/**
 * MCP has a JSON-only wire contract. Success uses its documented `{ value }`
 * structured-content envelope; declared failures are returned as JSON text.
 */
const mcpTool = (action: ToolEntry["action"], errors: ReadonlyArray<Action.Codec>): Tool.Any =>
  annotate(
    Tool.make(action.mcp.name, {
      description: action.description,
      parameters: Schema.toCodecJson(action.input),
      success: Schema.toCodecJson(Schema.Struct({ value: action.success })),
      failure: Schema.toCodecJson(Schema.Union(errors)),
      failureMode: "return",
    }),
    action.mcp,
  );

/**
 * MCP's input schema must describe a JSON object, including no-argument tools.
 * The compiled document hides an identified or recursive root behind a `$ref`,
 * which is followed into its definitions with Effect's own pointer parsing.
 */
const assertMcpObjectInput = (action: ToolEntry["action"]): void => {
  const { schema, definitions } = Schema.toJsonSchemaDocument(Schema.toCodecJson(action.input));
  const $ref = schema.$ref;

  if ($ref !== undefined && typeof $ref !== "string") {
    throw new Error(`${action.name}: MCP input schema $ref must be a string`);
  }

  const [scope, key, ...rest] =
    $ref === undefined ? [] : (JsonPointer.parseUriFragment($ref) ?? []);

  const root =
    scope === "$defs" && key !== undefined && rest.length === 0 ? definitions[key] : schema;

  if (root?.type !== "object") {
    throw new Error(
      `${action.name}: MCP input must have an object root; omit input for no arguments`,
    );
  }
};

/** The two concrete wire projections that share handler binding and lifetime ownership. */
type Projection = "native" | "mcp";

const project = (projection: Projection, entry: ToolEntry, options: ToolOptions): Tool.Any => {
  // A hook refusal is the surface's failure, so every tool declares it alongside
  // the action's own errors and returns it exactly as a handler failure.
  const errors = projectedErrors(entry.action, options.errors);

  const tool =
    projection === "native" ? nativeTool(entry.action, errors) : mcpTool(entry.action, errors);

  if (projection === "native") return tool;
  assertMcpObjectInput(entry.action);

  // The native server then refuses undeclared arguments and publishes closed input schemas.
  return tool.annotate(Tool.Strict, true);
};

const handler = (
  projection: Projection,
  app: AnyImplementation,
  action: ToolAction,
  handlers: Handlers<unknown>,
  before: Before<unknown> | undefined,
) => {
  const run = (input: ErasedValue) =>
    dispatch<ToolAction, ErasedValue, unknown>(app.group, action, handlers, before)(input);

  return projection === "native"
    ? run
    : (input: ErasedValue) => Effect.map(run(input), (value) => ({ value }));
};

/**
 * Project MCP-enabled actions and acquire their handlers exactly once per adapter layer.
 * Native and MCP differ only in tool codecs and the MCP success envelope; selection,
 * scoped acquisition, dispatch and native Toolkit binding stay identical.
 */
export const bindTools = (
  apps: ReadonlyArray<AnyImplementation>,
  projection: Projection,
  options: ToolOptions,
): BoundTools => {
  const served = toolApps(apps);
  const selected = entries(served);
  assertDistinctToolNames(selected);
  const toolkit = Toolkit.make(...selected.map((entry) => project(projection, entry, options)));

  const layer = toolkit.toLayer(
    Effect.map(
      Effect.forEach(served, ({ app, actions }) =>
        Effect.map(app.build, (handlers) => {
          // SAFETY: every selected action belongs to this app's exact group. Dynamic
          // Toolkit registration erases only the handler-record key set after selection.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- See invariant above.
          const record = handlers as Handlers<unknown>;

          return actions.map(
            (action) =>
              [action.mcp.name, handler(projection, app, action, record, options.before)] as const,
          );
        }),
      ),
      (built) => Object.fromEntries(built.flat()),
    ),
  );

  // SAFETY: Tool names are dynamic contract values, so Toolkit's precisely keyed
  // handler context is erased only inside this internal projection boundary.
  return { toolkit, layer } as BoundTools;
};
