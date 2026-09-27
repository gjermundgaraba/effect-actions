import { Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import type * as Action from "./Action.js";
import type { ToolErrors } from "./internal/errors.js";
import { bindTools } from "./internal/tools.js";
import {
  type ActionOf,
  type BuildContext,
  type BuildError,
  type Member,
  provideHandlers,
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

/** A tool needs what its handler and its implementation's `before` hook need. */
type ToolFor<App> = App extends unknown
  ? ActionOf<App> extends infer A extends Action.Any
    ? A extends Action.Any
      ? NativeTool<A, RequestOf<App, A>>
      : never
    : never
  : never;

type ToolkitTools<App> = {
  readonly [T in ToolFor<App> as T["name"]]: T;
};

/** Native tools and the layer that binds their action implementations. */
export interface Tools<T extends Record<string, Tool.Any>, E, R> {
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
 * when the resulting toolkit handles a call, the identity an implementation's `before` hook
 * reads included: the caller provides it.
 */
export function make<const Apps extends Served>(
  apps: Apps,
): Tools<ToolkitTools<Member<Apps>>, BuildError<Member<Apps>>, BuildContext<Member<Apps>>>;
export function make(apps: Served): ErasedTools {
  const served = toList(apps);
  const { toolkit, layer } = bindTools(served, "native");

  return { toolkit, layer: layer.pipe(provideHandlers(served)) };
}
