import { Effect, Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import type * as Action from "../Action.js";
import { projectedErrors } from "./actions.js";
import { refusals } from "./errors.js";
import {
  acquire,
  type AnyImplementation,
  type ErasedValue,
  servedActions,
} from "./implementation.js";

/** Native tools and their acquired action handlers, with dynamic names erased. */
interface BoundTools {
  readonly toolkit: Toolkit.Toolkit<Record<string, Tool.Any>>;
  /** The tool handlers; they need the implementations' handlers, which `provideHandlers` provides. */
  readonly layer: Layer.Layer<Tool.HandlersFor<Record<string, Tool.Any>>, unknown, unknown>;
}

/** A tool's hints: read-only exactly when its action reads, and the contract's others. */
const annotate = (tool: Tool.Any, { access, hints }: Action.Any) =>
  tool
    .annotate(Tool.Readonly, access === "read")
    .annotate(Tool.Destructive, hints.destructive)
    .annotate(Tool.Idempotent, hints.idempotent)
    .annotate(Tool.OpenWorld, hints.openWorld);

/**
 * A native Effect AI tool. Its schemas retain action transforms and its result
 * is the action result itself, rather than an MCP response envelope.
 */
const nativeTool = (action: Action.Any, errors: Action.Any["errors"]): Tool.Any =>
  annotate(
    Tool.make(action.name, {
      description: action.description,
      parameters: action.input,
      success: action.success,
      failure: Schema.Union(errors),
      failureMode: "return",
    }),
    action,
  );

/**
 * MCP has a JSON-only wire contract. Success uses its documented `{ value }`
 * structured-content envelope; declared failures are returned as JSON text. The native
 * server refuses undeclared arguments, publishes closed input schemas, and rejects any
 * input whose JSON Schema root is not an object.
 */
const mcpTool = (action: Action.Any, errors: Action.Any["errors"]): Tool.Any =>
  annotate(
    Tool.make(action.name, {
      description: action.description,
      parameters: Schema.toCodecJson(action.input),
      success: Schema.toCodecJson(Schema.Struct({ value: action.success })),
      failure: Schema.toCodecJson(Schema.Union(errors)),
      failureMode: "return",
    }),
    action,
  ).annotate(Tool.Strict, true);

/** The two concrete wire projections that share handler binding and lifetime ownership. */
type Projection = "native" | "mcp";

const project = (projection: Projection, action: Action.Any): Tool.Any => {
  // A hook refusal is the implementation's failure, so every tool declares the refusals
  // alongside the action's own errors and returns them exactly as a handler failure.
  const errors = projectedErrors(action, refusals);

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
): BoundTools => {
  // Fail before building handlers when two tools share a name.
  const actions = servedActions(projection === "mcp" ? "MCP tool" : "tool", apps);
  const toolkit = Toolkit.make(...actions.map((action) => project(projection, action)));

  const layer = toolkit.toLayer(
    Effect.map(acquire(apps), (bound) =>
      Object.fromEntries(
        bound.map(([action, run]) => [
          action.name,
          projection === "native"
            ? run
            : (input: ErasedValue) => Effect.map(run(input), (value) => ({ value })),
        ]),
      ),
    ),
  );

  // SAFETY: Tool names are dynamic contract values, so Toolkit's precisely keyed
  // handler context is erased only inside this internal projection boundary.
  return { toolkit, layer } as BoundTools;
};
