import { Array as Arr, Context, Effect, Layer, Option, Predicate, Schema } from "effect";
import type { Scope } from "effect";
import type * as Action from "../Action.js";
import { projectedErrors } from "./actions.js";
import type { Refusal } from "./errors.js";

/**
 * A random key segment, unique to its caller even across installed copies of this module,
 * where a counter of each copy would repeat another's.
 */
export const uniqueKey = (): string => Math.random().toString(36).slice(2);

/** Decoded values at the dispatch boundary every surface shares. */
export type ErasedValue = Action.Any["input"]["Type"];

// Method extraction intentionally makes the argument bivariant. A surface
// selects the action before it invokes a handler, so its decoded input is the
// matching handler input; handlers must not be widened at their public API.
export type ErasedHandler<R> = {
  handle(input: ErasedValue): Effect.Effect<ErasedValue, ErasedValue, R>;
}["handle"];

/** A surface's erased view of a record of handlers, keyed by action name. */
export type Handlers<R> = Readonly<Record<string, ErasedHandler<R>>>;

/** The errors the actions `A` declare: each action's, in turn. */
type DeclaredErrors<A extends Action.Any> = A extends unknown ? A["errors"][number]["Type"] : never;

/**
 * What a hook over `A` may fail with besides a refusal: an error one of the actions declares,
 * such as a rate limit. A call fails with it as typed only where its own action declares it;
 * any other is a defect naming the action, which `dispatch` checks for every surface. An
 * erased action's errors are `unknown`, which admits nothing: a hook typed over `Action.Any`
 * only refuses.
 */
export type HookErrors<A extends Action.Any> =
  DeclaredErrors<A> extends infer E ? (unknown extends E ? never : E) : never;

/**
 * An implementation's hook: whether a caller may call. It runs once per call on every
 * surface, after the input is decoded and before the selected handler, with its action
 * contract, so a policy reads `access` rather than the action name. It fails with a
 * refusal, answered as a declared error, or over HTTP as its status when an OAuth client
 * steps up on it, or with an error the action it receives declares, such as a rate limit.
 * Its services `RB` are request-time requirements, like a handler's.
 */
export type Before<A extends Action.Any, RB = never> = (
  action: A,
) => Effect.Effect<void, Refusal | HookErrors<A>, RB>;

/** An implementation's hook, erased. */
export type ErasedBefore = (action: Action.Any) => Effect.Effect<void, unknown, unknown>;

/** Each action of an implementation with its handler, as its builder made them. */
export type Bound = ReadonlyArray<readonly [Action.Any, ErasedHandler<unknown>]>;

/**
 * What a layer builds once per layer graph, under a key private to it: an implementation's
 * handlers, or its hook. Effect memoizes a layer by reference within one layer graph, so
 * everything in the graph holding this one shares one run.
 */
export interface Memoized<S, E, R> {
  readonly key: Context.Key<S, S>;
  readonly layer: Layer.Layer<S, E, R>;
}

/** What `build` makes, as a layer of its own. */
export const memoized = <S, E, R>(
  build: Effect.Effect<S, E, R>,
): Memoized<S, E, Exclude<R, Scope.Scope>> => {
  // A string key is a service's identity: one of its own for each.
  const key = Context.Service<S>(`effect-actions/Implementation/${uniqueKey()}`);

  return { key, layer: Layer.effect(key, build) };
};

/**
 * Actions bound to their handlers and their hook: everything one `Action.implement` call
 * produced, one builder serving every surface.
 *
 * The private fields make this class nominal: a structurally similar object,
 * including one made by spreading an implementation, is not an implementation.
 * `R` maps each action name to its handler's per-request requirements, and `~hook`, which
 * no action name can be, to its hook's; names typed only as `string` absorb that key, and each
 * then owes the hook's too. `EX` and `RX` are the failures and services of its handlers'
 * builder, and `EH` and `RH` of its hook's, which a share behind another hook leaves out. A
 * plain hook builds nothing.
 */
export class Implementation<
  A extends Action.Any,
  R extends { readonly [name: string]: unknown },
  EX,
  RX,
  EH = never,
  RH = never,
> {
  // Type-only fields, one per type parameter, so a type reads each by name.
  /** Type-only: each action's handler's per-request requirements, and the hook's. */
  declare readonly "~request": R;
  /** Type-only: what building its handlers fails with. */
  declare readonly "~buildError": EX;
  /** Type-only: what building its handlers needs. */
  declare readonly "~buildContext": RX;
  /** Type-only: what building its hook fails with. */
  declare readonly "~hookBuildError": EH;
  /** Type-only: what building its hook needs. */
  declare readonly "~hookBuildContext": RH;

  readonly #handlers: Memoized<Bound, EX, RX>;
  readonly #hook: Memoized<ErasedBefore, EH, RH>;

  constructor(
    /** The contracts this implementation answers. */
    readonly actions: ReadonlyArray<A>,
    /** Builds each action paired with its handler: its own builder, or the one it shares. */
    handlers: Memoized<Bound, EX, RX>,
    /** Builds its hook. */
    hook: Memoized<ErasedBefore, EH, RH>,
  ) {
    this.#handlers = handlers;
    this.#hook = hook;
  }

  /**
   * `actions` of `app` with its handlers, from its builder's one run, behind its hook or
   * `hook`: given one, the source's is neither built nor run for them.
   */
  static share(
    actions: ReadonlyArray<Action.Any>,
    app: AnyImplementation,
    hook: Memoized<ErasedBefore, unknown, unknown> | undefined,
  ): AnyImplementation {
    const source = Implementation.own(app);

    return new Implementation(actions, source.#handlers, hook ?? source.#hook);
  }

  /**
   * The key of what runs a call of `app`'s actions: its handlers' builder's and its hook's,
   * each unique to its memoized layer. A share that keeps its source's hook has its source's
   * key; one behind another hook does not. Static, so it stays off the public instance type.
   */
  static runKey(app: AnyImplementation): string {
    const source = Implementation.own(app);

    return `${source.#handlers.key.key}+${source.#hook.key.key}`;
  }

  /**
   * The builders of `app`, its handlers' and its hook's, as a layer. Effect memoizes each
   * by reference within one layer graph, so every surface serving `app` there, and every
   * implementation sharing its builder, shares one run. Static, so it stays off the
   * public instance type.
   */
  static layerOf(app: AnyImplementation): Layer.Layer<Bound | ErasedBefore, unknown, unknown> {
    const source = Implementation.own(app);

    return Layer.merge(source.#handlers.layer, source.#hook.layer);
  }

  /**
   * The actions of `app` with their handlers, behind its hook, from the context
   * `layerOf(app)` provides.
   */
  static boundOf(app: AnyImplementation): Effect.Effect<Bound, never, Bound | ErasedBefore> {
    const { actions } = app;
    const source = Implementation.own(app);

    return Effect.zipWith(source.#handlers.key, source.#hook.key, (bound, before) =>
      bound.flatMap(([action, handle]) =>
        actions.includes(action) ? [[action, dispatch(action, handle, before)] as const] : [],
      ),
    );
  }

  /** `app`, if this copy of the module made it; another installed copy's cannot be read. */
  private static own<App extends AnyImplementation>(app: App): App {
    if (!(#handlers in app)) {
      throw new Error(
        "Not an implementation made by this Action.implement: is effect-actions installed twice?",
      );
    }

    return app;
  }
}

// The one place listing every parameter. Each is covariant, so `unknown` admits every
// implementation, while a value of this type owes everything: a surface serving it asks
// for `unknown`, which nothing provides. Types read a parameter from its type-only field.
/** Any implementation, with its actions and channels erased. */
export type AnyImplementation<A extends Action.Any = Action.Any> = Implementation<
  A,
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Type-only requirements by action name, erased to the top type.
  { readonly [name: string]: unknown },
  unknown,
  unknown,
  unknown,
  unknown
>;

/** What a surface serves: one implementation, or a list of them. */
export type Served = AnyImplementation | ReadonlyArray<AnyImplementation>;

/** The implementations `S` stands for. */
export type Member<S> = S extends ReadonlyArray<infer App> ? App : S;

/** A surface's implementations as a list. */
export const toList = (served: Served): ReadonlyArray<AnyImplementation> => Arr.ensure(served);

/** The actions of the implementations a surface serves. */
export type ActionOf<App> = App extends { readonly actions: ReadonlyArray<infer A> } ? A : never;

/** Per-request requirements of `App`'s hook and handler for each `A` it implements. */
export type RequestOf<App, A extends Action.Any> = App extends {
  readonly "~request": infer R;
}
  ? A extends Action.Any
    ? A["name"] extends keyof R
      ? R[A["name"]] | R["~hook" & keyof R]
      : never
    : never
  : never;

/** Per-request requirements of the implementations a surface can invoke. */
export type RequestContext<App> = App extends { readonly "~request": infer R } ? R[keyof R] : never;

/** Builder failures of the implementations a surface builds, their hooks' included. */
export type BuildError<App> = App extends {
  readonly "~buildError": infer EX;
  readonly "~hookBuildError": infer EH;
}
  ? EX | EH
  : never;

/** Builder requirements of the implementations a surface builds, their hooks' included. */
export type BuildContext<App> = App extends {
  readonly "~buildContext": infer RX;
  readonly "~hookBuildContext": infer RH;
}
  ? RX | RH
  : never;

/**
 * Provide `layer` the handlers of `apps`. Each implementation's layer is memoized, so its
 * builder runs once per layer graph however many surfaces serve it.
 */
export const provideHandlers =
  (apps: ReadonlyArray<AnyImplementation>) =>
  <A, E, R>(layer: Layer.Layer<A, E, R>): Layer.Layer<A, unknown, unknown> => {
    const [first, ...rest] = apps.map((app) => Implementation.layerOf(app));

    return first === undefined ? layer : Layer.provide(layer, Layer.mergeAll(first, ...rest));
  };

/**
 * The builders of `apps` as one layer providing nothing: built above the surfaces, it runs
 * each builder once for all of them, since every surface builds the same memoized layers.
 */
export const builders = (
  apps: ReadonlyArray<AnyImplementation>,
): Layer.Layer<never, unknown, unknown> => Layer.empty.pipe(provideHandlers(apps));

/** Every action `apps` serve with its handler, behind its hook, as `provideHandlers` built them. */
export const acquire = (
  apps: ReadonlyArray<AnyImplementation>,
): Effect.Effect<Bound, never, unknown> =>
  Effect.map(
    Effect.forEach(apps, (app) => Implementation.boundOf(app)),
    (bound) => bound.flat(),
  );

/**
 * Every action `apps` serve with its handler, behind its hook, their builders built as layers
 * of the graph being built around the caller, into its memo map, as `HttpRouter` builds a
 * middleware's dependencies: a builder acquiring them shares each builder's one run with the
 * surfaces of its graph, whichever builds first. Outside any graph, a program under
 * `Effect.provide` shares that layer's, and one under none builds into a map of its own. The
 * caller's scope holds them; a surface serving them too keeps them until it is released.
 */
export const built = (
  apps: ReadonlyArray<AnyImplementation>,
): Effect.Effect<Bound, unknown, unknown> => {
  // Made here, so a value that is not an implementation is refused where it is passed.
  const layers = apps.map((app) => Implementation.layerOf(app));
  const [first, ...rest] = layers;

  return Effect.gen(function* () {
    if (first === undefined) return [];

    const current = yield* Effect.serviceOption(Layer.CurrentMemoMap);
    const memoMap = Option.getOrElse(current, Layer.makeMemoMapUnsafe);
    const scope = yield* Effect.scope;
    const context = yield* Layer.buildWithMemoMap(Layer.mergeAll(first, ...rest), memoMap, scope);

    return yield* Effect.provideContext(acquire(apps), context);
  });
};

/** The defect of a hook failing with `error`, which `action` does not declare. */
const undeclared = (action: Action.Any, error: ErasedValue): Error =>
  new Error(
    `Action "${action.name}": its hook failed with an error the action does not declare: ${
      Predicate.hasProperty(error, "_tag") ? String(error._tag) : String(error)
    }`,
  );

/**
 * `before` checked for `action`: a failure the action does not declare, as a hook typed over
 * several actions may fail with another's error, is a defect naming the action and its `_tag`.
 * The check runs as an Effect, as every codec does, so an error schema checked asynchronously
 * passes; a declared failure keeps its whole cause, its trace and any defect beside it.
 */
const guarded = (action: Action.Any, before: ErasedBefore) => {
  const declared = Schema.decodeUnknownEffect(Schema.toType(Schema.Union(projectedErrors(action))));

  return () =>
    before(action).pipe(
      Effect.tapError((error) =>
        Effect.catch(Effect.asVoid(declared(error)), () => Effect.die(undeclared(action, error))),
      ),
    );
};

/**
 * One action's handler behind its hook. The hook runs first, outside the action's span,
 * so what it fails with is attributed to the surface rather than to a handler that never ran.
 * Each call has a scope of its own, on every surface: what the hook and the handler acquire is
 * released when the call ends, the handler's first, so no call needs a `Scope` of its caller.
 */
const dispatch = (
  action: Action.Any,
  handle: ErasedHandler<unknown>,
  before: ErasedBefore,
): ErasedHandler<unknown> => {
  // The contract's identity, on the span and on every log line the handler
  // writes, so a trace or a log can be filtered by action without parsing names.
  const attributes = {
    "action.name": action.name,
    "action.access": action.access,
  };

  const hook = guarded(action, before);

  return (input) => {
    const handled = Effect.withSpan(
      Effect.annotateLogs(
        Effect.suspend(() => handle(input)),
        attributes,
      ),
      action.name,
      { captureStackTrace: false, attributes },
    );

    return Effect.scoped(Effect.flatMap(hook(), () => handled));
  };
};
