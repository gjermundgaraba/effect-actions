import { Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import type * as Action from "./Action.js";
import { bindTools } from "./internal/tools.js";
import {
  type AnyImplementation,
  type BeforeContext,
  type BuildContext,
  type BuildError,
  type HandlerContext,
  Implementation,
} from "./internal/implementation.js";

/** A native tool corresponding to an MCP-enabled action. */
type NativeTool<A extends Action.Any, R> = A extends {
  readonly mcp: { readonly name: infer Name extends string };
}
  ? Tool.Tool<
      Name,
      {
        readonly parameters: A["input"];
        readonly success: A["success"];
        readonly failure: Schema.Union<A["errors"]>;
        readonly failureMode: "return";
      },
      R
    >
  : never;

type HandlersOf<App extends AnyImplementation> =
  App extends Implementation<any, infer H, any, any, any> ? H : never;

/** A tool needs what its handler needs, plus what the group's `before` hook needs. */
type ToolForAction<App extends AnyImplementation, A extends Action.Any> = A extends {
  readonly mcp: object;
}
  ? NativeTool<
      A,
      | HandlerContext<HandlersOf<App>, Extract<A["name"], keyof HandlersOf<App>>>
      | BeforeContext<App>
    >
  : never;

type ToolsFor<App extends AnyImplementation> = App extends AnyImplementation
  ? ToolForAction<App, App["group"]["actions"][number]>
  : never;

type ToolkitTools<Apps extends ReadonlyArray<AnyImplementation>> = {
  readonly [T in ToolsFor<Apps[number]> as T["name"]]: T;
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
export function make<const Apps extends ReadonlyArray<AnyImplementation>>(
  ...apps: Apps
): Binding<ToolkitTools<Apps>, BuildError<Apps[number]>, BuildContext<Apps[number]>>;
export function make(...apps: ReadonlyArray<AnyImplementation>): {
  readonly toolkit: object;
  readonly layer: object;
} {
  return bindTools(apps, "native");
}
