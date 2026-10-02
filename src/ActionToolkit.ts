import type { Effect, Layer, Schema } from "effect";
import type { Tool, Toolkit } from "effect/ai";
import type * as Action from "./Action.js";
import type { BuiltIns } from "./internal/errors.js";
import { bindTools } from "./internal/tools.js";
import {
  type ActionOf,
  type BuildContext,
  type BuildError,
  Implementation,
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

/**
 * Native tools bound to their action implementations: a native `Toolkit` and the layer of
 * its handlers, for `LanguageModel`, `Toolkit.merge` or `handle`. Tools belong to their
 * implementations: the `layer` of any `make` call serves the tools of its implementations in
 * any `toolkit`, and of a share keeping an implementation's hook, while two implementations
 * behind different hooks, such as one and a share of it behind another hook, never run each
 * other's handlers, even with tools of one name.
 */
export interface Tools<T extends Record<string, Tool.Any>, E, R> {
  /** The native toolkit: its `tools` are the definitions, by name, with schemas, hints and approval. */
  readonly toolkit: Toolkit.Toolkit<T>;
  /** Acquires handlers once in the layer scope; handler requirements remain at invocation. */
  readonly layer: Layer.Layer<Tool.HandlersFor<T>, E, R>;
}

/**
 * One call of a tool, as `needsApproval` receives it: its action's name, the action, and
 * the call's decoded input. Checking `name` narrows the other two to that action's.
 */
type ToolCall<A extends Action.Any> = A extends Action.Any
  ? {
      readonly name: A["name"];
      readonly action: A;
      readonly input: A["input"]["Type"];
    }
  : never;

/** How `make` projects its tools. */
export interface Options<A extends Action.Any> {
  /**
   * Whether a model's call needs approval before it runs: a boolean, or an Effect of one, for
   * each call, with Effect's native approval context. `LanguageModel` asks for approval
   * instead of calling the tool when it is `true`. The Effect runs in the caller's context and
   * requires nothing, so it reads the caller with `Effect.serviceOption`. Defaults to none.
   */
  readonly needsApproval?: (
    call: ToolCall<A>,
    context: Tool.NeedsApprovalContext,
  ) => boolean | Effect.Effect<boolean>;
}

/** `Tools`, erased: the public signature restores its tools and channels. */
type ErasedTools = Tools<Record<string, Tool.Any>, unknown, unknown>;

/**
 * Project implementations into Effect's native AI toolkit: one tool per action, keyed by its
 * name.
 *
 * Unlike MCP, calls return the action's native success/failure values directly.
 * Build services are needed to construct `layer`; request services are needed
 * when the resulting toolkit handles a call, the identity an implementation's `before` hook
 * reads included: the caller provides it. `needsApproval` marks the calls a model must have
 * approved; it authorizes nothing, which stays the `before` hook's.
 */
export function make<const Apps extends Served>(
  implementations: Apps,
  options?: Options<ActionOf<Member<Apps>>>,
): Tools<
  { readonly [T in ToolFor<Member<Apps>> as T["name"]]: T },
  BuildError<Member<Apps>>,
  BuildContext<Member<Apps>>
>;
export function make(apps: Served, options?: Options<Action.Any>): ErasedTools {
  const served = toList(apps);
  const needsApproval = options?.needsApproval;

  const { toolkit, layer } = bindTools(served, {
    label: "tool",
    tool: (tool, action, app) =>
      Object.assign(
        // One check over every call: the native one of each tool hands it the call.
        needsApproval === undefined
          ? tool
          : tool.setNeedsApproval((input, context) =>
              needsApproval({ name: action.name, action, input }, context),
            ),
        // Effect finds a tool's handler by its `id`, which carries the key of what runs a
        // call, its implementation's handlers and hook: any `layer` of an implementation
        // serves any `toolkit` of it, and of an `Action.share` of it keeping its hook, while
        // two implementations, such as one and a share behind another hook, never run each
        // other's handlers.
        { id: `${Implementation.runKey(app)}/${action.name}` },
      ),
    handler: (run) => run,
  });

  return { toolkit, layer: layer.pipe(provideHandlers(served)) };
}
