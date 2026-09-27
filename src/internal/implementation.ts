import { Context, Effect, Layer } from "effect";
import type { Scope } from "effect";
import type * as Action from "../Action.js";
import { assertDistinct } from "./actions.js";
import type { Refusal } from "./errors.js";

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
 * An implementation's hook: whether a caller may call. It runs once per call on every
 * surface, after the input is decoded and before the selected handler, with its action
 * contract, so a policy reads `access` rather than the action name. It fails with a
 * refusal, answered exactly as a declared error. Its services `RB` are request-time
 * requirements, like a handler's.
 */
export type Before<A extends Action.Any, RB> = (action: A) => Effect.Effect<void, Refusal, RB>;

/** An implementation's hook, erased. */
type ErasedBefore = (action: Action.Any) => Effect.Effect<void, unknown, unknown>;

/** Per-request requirements of one handler. */
export type HandlerContext<H> = H extends (
  input: never,
) => Effect.Effect<infer _A, infer _E, infer R>
  ? R
  : never;

/** Each action of an implementation with its handler, behind the implementation's hook. */
export type Bound = ReadonlyArray<readonly [Action.Any, ErasedHandler<unknown>]>;

/** The bound handlers of one implementation, under a key private to it. */
type BoundKey = Context.Key<Bound, Bound>;

let implementations = 0;

/**
 * Actions bound to their handlers and their hook: everything one `Action.implement` call
 * binds.
 *
 * The private fields make this class nominal: a structurally similar object,
 * including one made by spreading an implementation, is not an implementation.
 * `R` maps each action name to its per-request requirements, its handler's and its hook's;
 * `EX` and `RX` are the failures and services of the builder.
 */
export class Implementation<
  A extends Action.Any,
  R extends { readonly [name: string]: unknown },
  EX,
  RX,
> {
  // Type-only fields, one per type parameter, so a type reads each by name.
  /** Type-only: each action's per-request requirements, by action name. */
  declare readonly "~request": R;
  /** Type-only: what building its handlers fails with. */
  declare readonly "~buildError": EX;
  /** Type-only: what building its handlers needs. */
  declare readonly "~buildContext": RX;

  readonly #key: BoundKey;
  readonly #layer: Layer.Layer<Bound, EX, RX>;

  constructor(
    /** The contracts this implementation answers. */
    readonly actions: ReadonlyArray<A>,
    /** Each action paired with its handler. */
    build: Effect.Effect<Bound, EX, RX | Scope.Scope>,
    before: ErasedBefore | undefined,
  ) {
    // A string key is a service's identity, so it is unique to this implementation
    // even across copies of this module.
    this.#key = Context.Service<Bound>(
      `effect-actions/Implementation/${(implementations += 1)}/${Math.random().toString(36).slice(2)}`,
    );
    // Each handler goes behind the hook once, when the handlers are built.
    this.#layer = Layer.effect(
      this.#key,
      Effect.map(build, (bound) =>
        bound.map(([action, handle]) => [action, dispatch(action, handle, before)] as const),
      ),
    );
  }

  /**
   * The builder of `app`, as a layer. Effect memoizes a layer by reference within one
   * build of the host's layers, so every adapter serving `app` shares one run. Static,
   * so it stays off the public instance type.
   */
  static layerOf<EX, RX>(app: Implementation<any, any, EX, RX>): Layer.Layer<Bound, EX, RX> {
    return Implementation.own(app).#layer;
  }

  /** The bound handlers of `app`, from the context `layerOf(app)` provides. */
  static boundOf(app: AnyImplementation): Effect.Effect<Bound, never, Bound> {
    return Implementation.own(app).#key;
  }

  /** `app`, if this copy of the module made it; another installed copy's cannot be read. */
  private static own<App extends AnyImplementation>(app: App): App {
    if (!(#key in app)) {
      throw new Error(
        "Not an implementation made by this Action.implement: is effect-actions installed twice?",
      );
    }

    return app;
  }
}

// The one place listing every parameter: `any` admits each implementation's, where
// `unknown` would not. Types read a parameter from its type-only field.
/** Any implementation, with its actions and channels erased. */
export type AnyImplementation<A extends Action.Any = Action.Any> = Implementation<A, any, any, any>;

/** What a surface serves: one implementation, or a list of them. */
export type Served = AnyImplementation | ReadonlyArray<AnyImplementation>;

/** The implementations `S` stands for. */
export type Member<S> = S extends ReadonlyArray<infer App> ? App : S;

/** A surface's implementations as a list. */
export const toList = (served: Served): ReadonlyArray<AnyImplementation> =>
  isList(served) ? served : [served];

const isList = (served: Served): served is ReadonlyArray<AnyImplementation> =>
  Array.isArray(served);

/** The actions of the implementations a surface serves. */
export type ActionOf<App> = App extends { readonly actions: ReadonlyArray<infer A> } ? A : never;

/** Per-request requirements of `App`'s handler for each `A` it implements. */
export type RequestOf<App, A extends Action.Any> = App extends {
  readonly "~request": infer R;
}
  ? A extends Action.Any
    ? A["name"] extends keyof R
      ? R[A["name"]]
      : never
    : never
  : never;

/** Per-request requirements of the implementations a surface can invoke. */
export type RequestContext<App> = App extends { readonly "~request": infer R } ? R[keyof R] : never;

/** Builder failures of the implementations a surface builds. */
export type BuildError<App> = App extends { readonly "~buildError": infer EX } ? EX : never;

/** Builder requirements of the implementations a surface builds. */
export type BuildContext<App> = App extends { readonly "~buildContext": infer RX } ? RX : never;

/** Every action `apps` serve, each once: a name served twice is refused. */
export const servedActions = (
  what: string,
  apps: ReadonlyArray<AnyImplementation>,
): ReadonlyArray<Action.Any> => {
  const actions = apps.flatMap((app) => app.actions);

  assertDistinct(what, actions, (action) => action.name);

  return actions;
};

/**
 * Provide `layer` the handlers of `apps`. Each implementation's layer is memoized, so its
 * builder runs once per host build however many adapters serve it.
 */
export const provideHandlers =
  (apps: ReadonlyArray<AnyImplementation>) =>
  <A, E, R>(layer: Layer.Layer<A, E, R>): Layer.Layer<A, unknown, unknown> => {
    const [first, ...rest] = apps.map((app) => Implementation.layerOf(app));

    return first === undefined ? layer : Layer.provide(layer, Layer.mergeAll(first, ...rest));
  };

/** Every action `apps` serve with its handler, behind its hook, as `provideHandlers` built them. */
export const acquire = (
  apps: ReadonlyArray<AnyImplementation>,
): Effect.Effect<Bound, never, unknown> =>
  Effect.map(
    Effect.forEach(apps, (app) => Implementation.boundOf(app)),
    (bound) => bound.flat(),
  );

/**
 * One action's handler behind its hook. The hook runs first, outside the action's span,
 * so a refusal is attributed to the surface rather than to a handler that never ran.
 */
const dispatch = (
  action: Action.Any,
  handle: ErasedHandler<unknown>,
  before: ErasedBefore | undefined,
): ErasedHandler<unknown> => {
  // The contract's identity, on the span and on every log line the handler
  // writes, so a trace or a log can be filtered by action without parsing names.
  const attributes = {
    "action.name": action.name,
    "action.access": action.access,
  };

  return (input) => {
    const handled = Effect.withSpan(
      Effect.annotateLogs(
        Effect.suspend(() => handle(input)),
        attributes,
      ),
      action.name,
      { captureStackTrace: false, attributes },
    );

    return before === undefined ? handled : Effect.flatMap(before(action), () => handled);
  };
};
