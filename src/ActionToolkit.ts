import { Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import type * as Action from "./Action.js";
import { bindTools, type SurfaceOptions } from "./internal/tools.js";
import {
  type AnyImplementation,
  type BuildContext,
  type BuildError,
  type HiddenFromMcp,
  type HandlerContext,
  Implementation,
} from "./internal/implementation.js";

/** What the in-process caller binds around the implementations it projects. */
export type Options<Errors extends ReadonlyArray<Action.Codec> = [], R = never> = SurfaceOptions<
  Errors,
  R
>;

/** A native tool corresponding to an action MCP may serve, named by its tool metadata. */
type NativeTool<A extends Action.Any, E extends Action.Codec, R> =
  Extract<A["mcp"], object> extends { readonly name: infer Name extends string }
    ? Tool.Tool<
        Name,
        {
          readonly parameters: A["input"];
          readonly success: A["success"];
          readonly failure: Schema.Union<ReadonlyArray<A["errors"][number] | E>>;
          readonly failureMode: "return";
        },
        R
      >
    : never;

type HandlersOf<App extends AnyImplementation> =
  App extends Implementation<any, infer H, any, any> ? H : never;

/**
 * A tool needs what its handler needs, plus what the binding's `before` hook needs. The
 * rule is `ActionMcp`'s: only an action certainly hidden from MCP has no tool.
 */
type ToolForAction<
  App extends AnyImplementation,
  A extends Action.Any,
  E extends Action.Codec,
  RB,
> = A extends HiddenFromMcp
  ? never
  : NativeTool<
      A,
      E,
      HandlerContext<HandlersOf<App>, Extract<A["name"], keyof HandlersOf<App>>> | RB
    >;

type ToolsFor<
  App extends AnyImplementation,
  E extends Action.Codec,
  RB,
> = App extends AnyImplementation
  ? ToolForAction<App, App["group"]["actions"][number], E, RB>
  : never;

type ToolkitTools<Apps extends ReadonlyArray<AnyImplementation>, E extends Action.Codec, RB> = {
  readonly [T in ToolsFor<Apps[number], E, RB> as T["name"]]: T;
};

/** Native tools and the layer that binds their action implementations. */
export interface Binding<Tools extends Record<string, Tool.Any>, E = never, R = never> {
  readonly toolkit: Toolkit.Toolkit<Tools>;
  /** Acquires handlers once in the layer scope; handler requirements remain at invocation. */
  readonly layer: Layer.Layer<Tool.HandlersFor<Tools>, E, R>;
}

/**
 * Project implementations into Effect's native AI toolkit.
 *
 * Unlike MCP, calls return the action's native success/failure values directly.
 * Build services are needed to construct `layer`; request services are needed
 * when the resulting toolkit handles a call.
 */
export function make<
  const Apps extends ReadonlyArray<AnyImplementation>,
  const Errors extends ReadonlyArray<Action.Codec> = [],
  RB = never,
>(
  apps: readonly [...Apps],
  options?: Options<Errors, RB>,
): Binding<
  ToolkitTools<Apps, Errors[number], RB>,
  BuildError<Apps[number], HiddenFromMcp>,
  BuildContext<Apps[number], HiddenFromMcp>
>;
export function make(
  apps: ReadonlyArray<AnyImplementation>,
  options: Options<ReadonlyArray<Action.Codec>, unknown> = {},
): {
  readonly toolkit: object;
  readonly layer: object;
} {
  return bindTools(apps, "native", options);
}
