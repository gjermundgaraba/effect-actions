import { Effect, Predicate } from "effect";
import type { Scope } from "effect";
import type * as Action from "../Action.js";

/** Decoded values at the adapter dispatch boundary. */
export type ErasedValue = Action.Any["input"]["Type"];

// Method extraction intentionally makes the argument bivariant. An adapter
// selects the action before it invokes a handler, so its decoded input is the
// matching handler input; handlers must not be widened at their public API.
export type ErasedHandler<R> = {
  handle(input: ErasedValue): Effect.Effect<ErasedValue, ErasedValue, R>;
}["handle"];

/** An adapter's erased view of a record of handlers, keyed by action name. */
export type Handlers<R> = Readonly<Record<string, ErasedHandler<R>>>;

/**
 * An adapter's erased view of the pre-handler hook one surface binds. It sees the
 * selected action contract, so a policy reads `access` rather than the action name.
 */
export type Before<R> = (action: Action.Any) => Effect.Effect<void, ErasedValue, R>;

/** Per-request requirements of one handler. */
export type HandlerContext<H> = H extends (
  input: never,
) => Effect.Effect<infer _A, infer _E, infer R>
  ? R
  : never;

/**
 * One action bound to its handler.
 *
 * The private field makes this class nominal: a structurally similar object,
 * including one made by spreading an implementation, is not an implementation.
 * `R` is the handler's per-request requirements; `EX` and `RX` are the failures
 * and services of its builder.
 */
export class Implementation<A extends Action.Any, R, EX, RX> {
  /** Type-only: the handler's per-request requirements. */
  declare readonly "~request": R;

  readonly #build: Effect.Effect<Handlers<unknown>, EX, RX | Scope.Scope>;

  private constructor(
    /** The contract this implementation answers. */
    readonly action: A,
    build: Effect.Effect<Handlers<unknown>, EX, RX | Scope.Scope>,
  ) {
    this.#build = build;
  }

  /**
   * The builder of the handlers record, shared by every implementation one
   * `Action.implement` call returns. Adapters run each distinct builder once.
   */
  get build(): Effect.Effect<Handlers<unknown>, EX, RX | Scope.Scope> {
    return this.#build;
  }

  static make<A extends Action.Any, R, EX, RX>(
    action: A,
    build: Effect.Effect<Handlers<unknown>, EX, RX | Scope.Scope>,
  ): Implementation<A, R, EX, RX> {
    return new Implementation(action, build);
  }
}

// `any` is a wildcard in these inference positions; `unknown` would fail to match.
/** Any implementation, with its action and channels erased. */
export type AnyImplementation<A extends Action.Any = Action.Any> = Implementation<A, any, any, any>;

/** What hides an action from MCP and Toolkit types: an `mcp` type of exactly `false`. The one rule both use. */
export type HiddenFromMcp = { readonly mcp: false };

/**
 * Per-request requirements of the implementations a surface can invoke: all of them,
 * less those whose action matches `Hidden`. An action whose `mcp` may be `false` at
 * runtime does not match, so it keeps its requirements.
 */
export type RequestContext<App, Hidden = never> =
  App extends Implementation<infer A, infer R, any, any> ? (A extends Hidden ? never : R) : never;

/** Builder failures of the implementations a surface builds. */
export type BuildError<App, Hidden = never> =
  App extends Implementation<infer A, any, infer EX, any> ? (A extends Hidden ? never : EX) : never;

/** Builder requirements of the implementations a surface builds. */
export type BuildContext<App, Hidden = never> =
  App extends Implementation<infer A, any, any, infer RX> ? (A extends Hidden ? never : RX) : never;

/** An adapter's view of the acquired handler of one implementation. */
export type HandlerOf = (app: AnyImplementation) => ErasedHandler<unknown>;

/**
 * Run each distinct builder of `apps` once, in the caller's scope, and look up the handler
 * of any of them. This is where a record without a function for a served action is
 * refused: the layer build dies, since the types already refuse it.
 */
export const acquire = (
  apps: ReadonlyArray<AnyImplementation>,
): Effect.Effect<HandlerOf, unknown, unknown> =>
  Effect.map(
    Effect.forEach(new Set(apps.map((app) => app.build)), (build) =>
      Effect.map(build, (handlers) => [build, handlers] as const),
    ),
    (built) => {
      const records = new Map(built);

      return (app) => {
        const handlers = records.get(app.build);

        const handle =
          handlers !== undefined && Object.hasOwn(handlers, app.action.name)
            ? handlers[app.action.name]
            : undefined;

        if (!Predicate.isFunction(handle)) throw new Error(`Missing handler: ${app.action.name}`);

        return handle;
      };
    },
  );

/**
 * Invoke one action's handler. The surface's pre-handler hook runs first, outside the
 * action's span, so a refusal is attributed to the surface rather than to a handler that
 * never ran. `R` remains in the returned effect so transport layers cannot erase
 * required per-request services while assembling routes.
 */
export const dispatch = <A extends Action.Any, EB, R>(
  action: A,
  handle: ErasedHandler<unknown>,
  before: Before<R> | undefined,
) => {
  // The contract's identity, on the span and on every log line the handler
  // writes, so a trace or a log can be filtered by action without parsing names.
  const attributes = {
    "action.name": action.name,
    "action.access": action.access,
  };

  return (
    input: A["input"]["Type"],
  ): Effect.Effect<A["success"]["Type"], A["errors"][number]["Type"] | EB, R> => {
    const handled = Effect.withSpan(
      Effect.annotateLogs(
        Effect.suspend(() => handle(input)),
        attributes,
      ),
      action.name,
      { captureStackTrace: false, attributes },
    );

    const invoked = before === undefined ? handled : Effect.flatMap(before(action), () => handled);

    // SAFETY: the selected action identifies the only handler invoked, whose
    // contract fixes this input, success and failure schema, and whose requirements
    // the adapter's public signature restores. The hook fails only with the surface
    // errors the adapter declares on `EB`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- See invariant above.
    return invoked as Effect.Effect<A["success"]["Type"], A["errors"][number]["Type"] | EB, R>;
  };
};
