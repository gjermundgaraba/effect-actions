import { Effect, type Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import type * as Action from "../Action.js";
import { assertOnce, projectedErrors } from "./actions.js";
import { acquire, type AnyImplementation, type ErasedHandler } from "./implementation.js";

/** Native tools and their acquired action handlers, with dynamic names erased. */
interface BoundTools {
  readonly toolkit: Toolkit.Toolkit<Record<string, Tool.Any>>;
  /** The tool handlers; they need the implementations' handlers, which `provideHandlers` provides. */
  readonly layer: Layer.Layer<Tool.HandlersFor<Record<string, Tool.Any>>, unknown, unknown>;
}

/**
 * How a surface projects an action as a tool: what it adds to the tool and what a call of it
 * runs. Selection, codecs, dispatch, hints and binding are shared.
 */
export interface Projection {
  /** What a tool is called in `Duplicate <label>: <name>`. */
  readonly label: string;
  /** The surface's own form of `tool`, the tool of `action`, one of `app`'s. */
  readonly tool: (tool: Tool.Any, action: Action.Any, app: AnyImplementation) => Tool.Any;
  /** What a call of the tool runs, given the action's handler behind its hook. */
  readonly handler: (run: ErasedHandler<unknown>) => ErasedHandler<unknown>;
}

/** A tool's hints: read-only exactly when its action reads, and the contract's others. */
const annotate = (tool: Tool.Any, { access, hints }: Action.Any) =>
  tool
    .annotate(Tool.Readonly, access === "read")
    .annotate(Tool.Destructive, hints.destructive)
    .annotate(Tool.Idempotent, hints.idempotent)
    .annotate(Tool.OpenWorld, hints.openWorld);

/**
 * The native tool of `action`. A model and an MCP client speak JSON, so it takes and gives
 * the JSON encoding its schemas advertise, the whole success; handlers and callers see decoded
 * values. A hook refusal, or a handler's built-in failure, is the implementation's failure, so
 * it declares the built-in errors alongside the action's own, and returns them as its result.
 */
const toolOf = (action: Action.Any) =>
  Tool.make(action.name, {
    description: action.description,
    parameters: Schema.toCodecJson(action.input),
    success: Schema.toCodecJson(action.success),
    failure: Schema.toCodecJson(Schema.Union(projectedErrors(action))),
    failureMode: "return",
  });

/**
 * Project actions as tools named after them, sharing each implementation's built handlers.
 */
export const bindTools = (
  apps: ReadonlyArray<AnyImplementation>,
  projection: Projection,
): BoundTools => {
  // Fail before building handlers when two tools share a name.
  assertOnce(
    projection.label,
    apps.flatMap((app) => app.actions),
  );

  const toolkit = Toolkit.make(
    ...apps.flatMap((app) =>
      app.actions.map((action) => annotate(projection.tool(toolOf(action), action, app), action)),
    ),
  );

  const layer = toolkit.toLayer(
    Effect.map(acquire(apps), (bound) =>
      Object.fromEntries(bound.map(([action, run]) => [action.name, projection.handler(run)])),
    ),
  );

  // SAFETY: Tool names are dynamic contract values, so Toolkit's precisely keyed
  // handler context is erased only inside this internal projection boundary.
  return { toolkit, layer } as BoundTools;
};
