import { Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import type * as Action from "./Action.js";
import type { ToolErrors } from "./internal/errors.js";
import { bindTools } from "./internal/tools.js";
import {
  type ActionOf,
  type BuildContext,
  type BuildError,
  type Hook,
  type Member,
  type RequestOf,
  type Served,
  toList,
} from "./internal/implementation.js";

/** A native tool named after its action. */
type NativeTool<A extends Action.Any, R> = Tool.Tool<
  A["name"],
  {
    readonly parameters: A["input"];
    readonly success: A["success"];
    readonly failure: Schema.Union<ReadonlyArray<A["errors"][number] | ToolErrors>>;
    readonly failureMode: "return";
  },
  R
>;

/** A tool needs what its handler needs, plus what the `before` hook needs. */
type ToolFor<App, RB> = App extends unknown
  ? ActionOf<App> extends infer A extends Action.Any
    ? A extends Action.Any
      ? NativeTool<A, RequestOf<App, A> | RB>
      : never
    : never
  : never;

type ToolkitTools<App, RB> = {
  readonly [T in ToolFor<App, RB> as T["name"]]: T;
};

/** Native tools and the layer that binds their action implementations. */
interface Tools<T extends Record<string, Tool.Any>, E, R> {
  readonly toolkit: Toolkit.Toolkit<T>;
  /** Acquires handlers once in the layer scope; handler requirements remain at invocation. */
  readonly layer: Layer.Layer<Tool.HandlersFor<T>, E, R>;
}

/** `Tools`, erased: the public signature restores its tools and channels. */
interface ErasedTools {
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
export function make<const Apps extends Served, RB = never>(
  apps: Apps,
  options?: Hook<RB>,
): Tools<ToolkitTools<Member<Apps>, RB>, BuildError<Member<Apps>>, BuildContext<Member<Apps>>>;
export function make(apps: Served, options: Hook<unknown> = {}): ErasedTools {
  const { toolkit, layer, handlers } = bindTools(toList(apps), "native", options);

  return { toolkit, layer: handlers(layer) };
}
