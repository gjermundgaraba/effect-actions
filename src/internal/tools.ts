import { Effect, Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import type * as Action from "../Action.js";
import { assertDistinct, projectedErrors } from "./actions.js";
import { acquire, type AnyImplementation, dispatch, type ErasedValue } from "./implementation.js";

/** What a tool surface binds around the implementations it projects. */
export interface SurfaceOptions<Errors extends ReadonlyArray<Action.Codec>, R> {
  /**
   * Failures the surface answers with instead of a handler: authorization, rate
   * limits. Declared on every tool, so a refusal is returned exactly like an
   * action's own error.
   */
  readonly errors?: Errors;
  /**
   * Runs once per tool call, after the arguments are decoded and before the
   * selected handler, with the action contract it is about to run. It fails with
   * this surface's `errors`. Its services are request-time requirements, like a
   * handler's.
   */
  readonly before?: (action: Action.Any) => Effect.Effect<void, Errors[number]["Type"], R>;
}

/** The erased view every tool projection binds. */
export type ToolOptions = SurfaceOptions<ReadonlyArray<Action.Codec>, unknown>;

type ToolAction = Action.Any & { readonly mcp: Exclude<Action.Any["mcp"], false> };

/** An implementation whose action MCP and Toolkits may serve. */
type ToolApp = AnyImplementation<ToolAction>;

const isToolApp = (app: AnyImplementation): app is ToolApp => app.action.mcp !== false;

/** Native tools and their acquired action handlers, with dynamic names erased. */
interface BoundTools {
  readonly toolkit: Toolkit.Toolkit<Record<string, Tool.Any>>;
  readonly layer: Layer.Layer<Tool.HandlersFor<Record<string, Tool.Any>>, unknown, unknown>;
}

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
const nativeTool = (action: ToolAction, errors: ReadonlyArray<Action.Codec>): Tool.Any =>
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
const mcpTool = (action: ToolAction, errors: ReadonlyArray<Action.Codec>): Tool.Any =>
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

/** The two concrete wire projections that share handler binding and lifetime ownership. */
type Projection = "native" | "mcp";

const project = (projection: Projection, action: ToolAction, options: ToolOptions): Tool.Any => {
  // A hook refusal is the surface's failure, so every tool declares it alongside
  // the action's own errors and returns it exactly as a handler failure.
  const errors = projectedErrors(action, options.errors);

  const tool = projection === "native" ? nativeTool(action, errors) : mcpTool(action, errors);

  if (projection === "native") return tool;

  // The native server refuses undeclared arguments, publishes closed input schemas,
  // and rejects any input whose JSON Schema root is not an object.
  return tool.annotate(Tool.Strict, true);
};

/**
 * Project MCP-enabled actions and acquire their handlers exactly once per adapter layer.
 * Native and MCP differ only in tool codecs and the MCP success envelope; selection,
 * scoped acquisition, dispatch and native Toolkit binding stay identical. Only sources
 * with a served action are acquired.
 */
export const bindTools = (
  apps: ReadonlyArray<AnyImplementation>,
  projection: Projection,
  options: ToolOptions,
): BoundTools => {
  const served = apps.filter(isToolApp);
  // Fail before acquiring handlers when two exposed tools share a name.
  assertDistinct(
    "MCP tool",
    served.map((app) => app.action.mcp.name),
  );
  const toolkit = Toolkit.make(...served.map((app) => project(projection, app.action, options)));

  const layer = toolkit.toLayer(
    Effect.map(acquire(served), (handlerOf) =>
      Object.fromEntries(
        served.map((app) => {
          const run = dispatch<ToolAction, ErasedValue, unknown>(
            app.action,
            handlerOf(app),
            options.before,
          );

          return [
            app.action.mcp.name,
            projection === "native"
              ? run
              : (input: ErasedValue) => Effect.map(run(input), (value) => ({ value })),
          ] as const;
        }),
      ),
    ),
  );

  // SAFETY: Tool names are dynamic contract values, so Toolkit's precisely keyed
  // handler context is erased only inside this internal projection boundary.
  return { toolkit, layer } as BoundTools;
};
