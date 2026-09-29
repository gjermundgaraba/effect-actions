import { Context, Effect, Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/ai";
import type * as Action from "./Action.js";
import type { BuiltIns } from "./internal/errors.js";
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

/** A native tool named after its action, taking and giving JSON. */
type NativeTool<A extends Action.Any, R> = Tool.Tool<
  A["name"],
  {
    readonly parameters: Schema.toCodecJson<A["input"]>;
    readonly success: Schema.toCodecJson<A["success"]>;
    readonly failure: Schema.toCodecJson<
      Schema.Union<ReadonlyArray<A["errors"][number] | BuiltIns>>
    >;
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

/** The handled toolkit of one `make` call, which its `layer` provides. */
export interface Handled<T extends Record<string, Tool.Any>> {
  readonly "~tools": T;
}

/**
 * Native tools bound to their action implementations: `toolkit` gives the handled toolkit
 * that `layer` provides, for `LanguageModel` or `handle`. Each `make` call's handlers stay its
 * own, so toolkits with tools of one name never run each other's handlers.
 */
export interface Tools<T extends Record<string, Tool.Any>, E, R> {
  /** The native tool definitions, by name: their schemas, hints and approval. */
  readonly tools: T;
  readonly toolkit: Effect.Effect<Toolkit.WithHandler<T>, never, Handled<T>>;
  /** Acquires handlers once in the layer scope; handler requirements remain at invocation. */
  readonly layer: Layer.Layer<Handled<T>, E, R>;
}

/** How `make` projects its tools. */
export interface Options<A extends Action.Any> {
  /**
   * Whether an action's tool needs approval before it runs: Effect's native
   * `Tool.needsApproval`, a boolean or a function of each call's input, which
   * `LanguageModel` honors by asking for approval instead of calling the tool. Read once
   * per action when `make` runs. Defaults to none.
   */
  readonly needsApproval?: (action: A) => Tool.NeedsApproval<A["input"]>;
}

/** `Tools`, erased: the public signature restores its tools and channels. */
type ErasedTools = Tools<Record<string, Tool.Any>, unknown, unknown>;

/**
 * Project implementations into Effect's native AI toolkit.
 *
 * Unlike MCP, calls return the action's native success/failure values directly.
 * Build services are needed to construct `layer`; request services are needed
 * when the resulting toolkit handles a call, the identity an implementation's `before` hook
 * reads included: the caller provides it. `needsApproval` marks the tools a model's
 * call must be approved for; it authorizes nothing, which stays the `before` hook's.
 */
export function make<const Apps extends Served>(
  implementations: Apps,
  options?: Options<ActionOf<Member<Apps>>>,
): Tools<ToolkitTools<Member<Apps>>, BuildError<Member<Apps>>, BuildContext<Member<Apps>>>;
export function make(apps: Served, options?: Options<Action.Any>): ErasedTools {
  const served = toList(apps);

  // A model speaks JSON: each tool takes and gives the JSON encoding its schema advertises,
  // as an MCP tool does, without MCP's envelope. Handlers and callers see decoded values.
  const { toolkit, layer } = bindTools(served, {
    label: "tool",
    tool: (action, errors) =>
      Tool.make(action.name, {
        description: action.description,
        parameters: Schema.toCodecJson(action.input),
        success: Schema.toCodecJson(action.success),
        failure: Schema.toCodecJson(Schema.Union(errors)),
        failureMode: "return",
        needsApproval: options?.needsApproval?.(action),
      }),
    handler: (run) => run,
  });

  // Effect finds a tool's handler by the tool's name, in context: kept inside this layer, a
  // handler never reaches another toolkit with a tool of that name.
  const handled = Context.Service<
    Handled<Record<string, Tool.Any>>,
    Toolkit.WithHandler<Record<string, Tool.Any>>
  >(`effect-actions/Tools/${Math.random().toString(36).slice(2)}`);

  return {
    tools: toolkit.tools,
    toolkit: Effect.service(handled),
    layer: Layer.effect(handled, toolkit).pipe(Layer.provide(layer), provideHandlers(served)),
  };
}
