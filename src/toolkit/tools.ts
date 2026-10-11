import { type Context, Effect, type Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import type * as Action from "../contract/Action.js";
import { assertOnce, projectedErrors } from "../contract/rules.js";
import { acquire, type AnyImplementation, type ErasedHandler } from "../contract/implementation.js";

interface BoundTools {
  readonly toolkit: Toolkit.Toolkit<Record<string, Tool.Any>>;
  readonly layer: Layer.Layer<Tool.HandlersFor<Record<string, Tool.Any>>, unknown, unknown>;
}

export interface Projection {
  readonly label: string;
  readonly tool: (tool: Tool.Any, action: Action.Any, app: AnyImplementation) => Tool.Any;
  readonly handler?: (run: ErasedHandler<unknown>, action: Action.Any) => ErasedHandler<unknown>;
}

const annotateIfGiven = <I, S>(tool: Tool.Any, key: Context.Key<I, S>, value: S | undefined) =>
  value === undefined ? tool : tool.annotate(key, value);

const annotateFromContract = (tool: Tool.Any, { readOnly, mcp }: Action.Any) => {
  const destructiveUnlessReadOnly = mcp.destructiveHint ?? (readOnly ? false : undefined);
  const meta = mcp._meta === undefined ? undefined : { ...mcp._meta };

  const hinted = annotateIfGiven(
    annotateIfGiven(
      annotateIfGiven(
        tool.annotate(Tool.Readonly, readOnly),
        Tool.Destructive,
        destructiveUnlessReadOnly,
      ),
      Tool.Idempotent,
      mcp.idempotentHint,
    ),
    Tool.OpenWorld,
    mcp.openWorldHint,
  );

  return annotateIfGiven(annotateIfGiven(hinted, Tool.Title, mcp.title), Tool.Meta, meta);
};

const jsonToolOf = (action: Action.Any) =>
  Tool.make(action.name, {
    description: action.description,
    parameters: Schema.toCodecJson(action.input),
    success: Schema.toCodecJson(action.success),
    failure: Schema.toCodecJson(Schema.Union(projectedErrors(action))),
    failureMode: "return",
  });

export const bindTools = (
  apps: ReadonlyArray<AnyImplementation>,
  projection: Projection,
): BoundTools => {
  assertOnce(
    projection.label,
    apps.flatMap((app) => app.actions),
  );

  const toolkit = Toolkit.make(
    ...apps.flatMap((app) =>
      app.actions.map((action) =>
        annotateFromContract(projection.tool(jsonToolOf(action), action, app), action),
      ),
    ),
  );

  const layer = toolkit.toLayer(
    Effect.map(acquire(apps), (bound) =>
      Object.fromEntries(
        bound.map(([action, run]) => [action.name, projection.handler?.(run, action) ?? run]),
      ),
    ),
  );

  return { toolkit, layer };
};
