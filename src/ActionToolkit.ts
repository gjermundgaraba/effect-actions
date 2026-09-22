import { type Effect, Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import type * as Action from "./Action.js";
import { bindTools } from "./internal/tools.js";
import {
  type AnyImplementation,
  type BuildContext,
  type BuildError,
  type HandlerContext,
  Implementation,
} from "./internal/implementation.js";

/** What `make` binds around the implementations it projects. */
export interface Options<Errors extends ReadonlyArray<Action.Codec> = [], R = never> {
  /**
   * Failures the caller answers with instead of a handler: authorization, rate
   * limits. Declared on every tool, so a refusal is returned as a tool failure
   * exactly like an action's own error.
   */
  readonly errors?: Errors;
  /**
   * Runs once per tool call, before the selected handler, with the action contract
   * it is about to run. It fails with this binding's `errors`. Its services join
   * each tool's request requirements, like a handler's.
   */
  readonly before?: (action: Action.Any) => Effect.Effect<void, Errors[number]["Type"], R>;
}

/** A native tool corresponding to an MCP-enabled action. */
type NativeTool<A extends Action.Any, E extends Action.Codec, R> = A extends {
  readonly mcp: { readonly name: infer Name extends string };
}
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

/** A tool needs what its handler needs, plus what the binding's `before` hook needs. */
type ToolForAction<
  App extends AnyImplementation,
  A extends Action.Any,
  E extends Action.Codec,
  RB,
> = A extends {
  readonly mcp: object;
}
  ? NativeTool<
      A,
      E,
      HandlerContext<HandlersOf<App>, Extract<A["name"], keyof HandlersOf<App>>> | RB
    >
  : never;

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
  BuildError<Apps[number], "mcp">,
  BuildContext<Apps[number], "mcp">
>;
export function make(
  apps: ReadonlyArray<AnyImplementation>,
  options: Options<ReadonlyArray<Action.Codec>, unknown> = {},
): {
  readonly toolkit: object;
  readonly layer: object;
} {
  return bindTools(apps, "native", { errors: options.errors, before: options.before });
}
