import { Effect, type Layer } from "effect";
import { Tool, Toolkit } from "effect/ai";
import type * as Action from "../Action.js";
import { projectedErrors } from "./actions.js";
import { refusals } from "./errors.js";
import {
  acquire,
  type AnyImplementation,
  type ErasedHandler,
  servedActions,
} from "./implementation.js";

/** Native tools and their acquired action handlers, with dynamic names erased. */
interface BoundTools {
  readonly toolkit: Toolkit.Toolkit<Record<string, Tool.Any>>;
  /** The tool handlers; they need the implementations' handlers, which `provideHandlers` provides. */
  readonly layer: Layer.Layer<Tool.HandlersFor<Record<string, Tool.Any>>, unknown, unknown>;
}

/**
 * How a surface projects an action as a tool: its tool's codecs and what a call of it
 * runs. Selection, dispatch, hints and binding are shared.
 */
export interface Projection {
  /** What a tool is called in `Duplicate <label>: <name>`. */
  readonly label: string;
  /** The tool of `action`, declaring `errors`: its own and the refusals. */
  readonly tool: (action: Action.Any, errors: Action.Any["errors"]) => Tool.Any;
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
 * Project actions as tools named after them, sharing each implementation's built handlers.
 */
export const bindTools = (
  apps: ReadonlyArray<AnyImplementation>,
  projection: Projection,
): BoundTools => {
  // Fail before building handlers when two tools share a name.
  const actions = servedActions(projection.label, apps);

  // A hook refusal is the implementation's failure, so every tool declares the refusals
  // alongside the action's own errors and returns them exactly as a handler failure.
  const toolkit = Toolkit.make(
    ...actions.map((action) =>
      annotate(projection.tool(action, projectedErrors(action, refusals)), action),
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
