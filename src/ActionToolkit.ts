import { Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import type * as Action from "./Action.js";
import { bindTools, type SurfaceOptions } from "./internal/tools.js";
import {
  type ActionOf,
  type BuildContext,
  type BuildError,
  type Member,
  type RequestOf,
  type Served,
  toList,
} from "./internal/implementation.js";

/** What the in-process caller binds around the implementations it projects. */
export type Options<Errors extends ReadonlyArray<Action.Codec> = [], R = never> = SurfaceOptions<
  Errors,
  R
>;

/** A native tool named after its action. */
type NativeTool<A extends Action.Any, E extends Action.Codec, R> = Tool.Tool<
  A["name"],
  {
    readonly parameters: A["input"];
    readonly success: A["success"];
    readonly failure: Schema.Union<ReadonlyArray<A["errors"][number] | E>>;
    readonly failureMode: "return";
  },
  R
>;

/** A tool needs what its handler needs, plus what the binding's `before` hook needs. */
type ToolFor<App, E extends Action.Codec, RB> = App extends unknown
  ? ActionOf<App> extends infer A extends Action.Any
    ? A extends Action.Any
      ? NativeTool<A, E, RequestOf<App, A> | RB>
      : never
    : never
  : never;

type ToolkitTools<App, E extends Action.Codec, RB> = {
  readonly [T in ToolFor<App, E, RB> as T["name"]]: T;
};

/** Native tools and the layer that binds their action implementations. */
export interface Binding<Tools extends Record<string, Tool.Any>, E = never, R = never> {
  readonly toolkit: Toolkit.Toolkit<Tools>;
  /** Acquires handlers once in the layer scope; handler requirements remain at invocation. */
  readonly layer: Layer.Layer<Tool.HandlersFor<Tools>, E, R>;
}

/** `Binding`, erased: the public signature restores its tools and channels. */
interface ErasedBinding {
  readonly toolkit: object;
  readonly layer: object;
}

/**
 * Project implementations into Effect's native AI toolkit.
 *
 * Unlike MCP, calls return the action's native success/failure values directly.
 * Build services are needed to construct `layer`; request services are needed
 * when the resulting toolkit handles a call.
 */
export function make<
  const Apps extends Served,
  const Errors extends ReadonlyArray<Action.Codec> = [],
  RB = never,
>(
  apps: Apps,
  options?: Options<Errors, RB>,
): Binding<
  ToolkitTools<Member<Apps>, Errors[number], RB>,
  BuildError<Member<Apps>>,
  BuildContext<Member<Apps>>
>;
export function make(
  apps: Served,
  options: Options<ReadonlyArray<Action.Codec>, unknown> = {},
): ErasedBinding {
  const { toolkit, layer, handlers } = bindTools(toList(apps), "native", options);

  return { toolkit, layer: handlers(layer) };
}
