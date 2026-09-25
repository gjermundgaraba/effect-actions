import { Effect, Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import type * as Action from "../Action.js";
import { projectedErrors } from "./actions.js";
import {
  acquire,
  type AnyImplementation,
  dispatch,
  type ErasedValue,
  provideHandlers,
  servedActions,
} from "./implementation.js";

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

/** Native tools and their acquired action handlers, with dynamic names erased. */
interface BoundTools {
  readonly toolkit: Toolkit.Toolkit<Record<string, Tool.Any>>;
  /** The tool handlers; they need the implementations' handlers, which `handlers` provides. */
  readonly layer: Layer.Layer<Tool.HandlersFor<Record<string, Tool.Any>>, unknown, unknown>;
  readonly handlers: <A, E, R>(layer: Layer.Layer<A, E, R>) => Layer.Layer<A, unknown, unknown>;
}

const annotate = (tool: Tool.Any, mcp: Action.Any["mcp"]) =>
  tool
    .annotate(Tool.Readonly, mcp.readOnly)
    .annotate(Tool.Destructive, mcp.destructive)
    .annotate(Tool.Idempotent, mcp.idempotent)
    .annotate(Tool.OpenWorld, mcp.openWorld);

/**
 * A native Effect AI tool. Its schemas retain action transforms and its result
 * is the action result itself, rather than an MCP response envelope.
 */
const nativeTool = (action: Action.Any, errors: ReadonlyArray<Action.Codec>): Tool.Any =>
  annotate(
    Tool.make(action.name, {
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
 * structured-content envelope; declared failures are returned as JSON text. The native
 * server refuses undeclared arguments, publishes closed input schemas, and rejects any
 * input whose JSON Schema root is not an object.
 */
const mcpTool = (action: Action.Any, errors: ReadonlyArray<Action.Codec>): Tool.Any =>
  annotate(
    Tool.make(action.name, {
      description: action.description,
      parameters: Schema.toCodecJson(action.input),
      success: Schema.toCodecJson(Schema.Struct({ value: action.success })),
      failure: Schema.toCodecJson(Schema.Union(errors)),
      failureMode: "return",
    }),
    action.mcp,
  ).annotate(Tool.Strict, true);

/** The two concrete wire projections that share handler binding and lifetime ownership. */
type Projection = "native" | "mcp";

const project = (projection: Projection, action: Action.Any, options: ToolOptions): Tool.Any => {
  // A hook refusal is the surface's failure, so every tool declares it alongside
  // the action's own errors and returns it exactly as a handler failure.
  const errors = projectedErrors(action, options.errors);

  return projection === "native" ? nativeTool(action, errors) : mcpTool(action, errors);
};

/**
 * Project actions as tools named after them, sharing each implementation's built handlers.
 * Native and MCP differ only in tool codecs and the MCP success envelope; selection,
 * dispatch and native Toolkit binding stay identical.
 */
export const bindTools = (
  apps: ReadonlyArray<AnyImplementation>,
  projection: Projection,
  options: ToolOptions,
): BoundTools => {
  // Fail before building handlers when two tools share a name.
  const actions = servedActions(projection === "mcp" ? "MCP tool" : "tool", apps);
  const toolkit = Toolkit.make(...actions.map((action) => project(projection, action, options)));

  const layer = toolkit.toLayer(
    Effect.map(acquire(apps), (handlerOf) =>
      Object.fromEntries(
        actions.map((action) => {
          const run = dispatch<Action.Any, ErasedValue, unknown>(
            action,
            handlerOf(action),
            options.before,
          );

          return [
            action.name,
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
  return { toolkit, layer, handlers: provideHandlers(apps) } as BoundTools;
};
