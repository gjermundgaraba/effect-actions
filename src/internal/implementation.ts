import { Array as Arr, Context, Effect, Layer, Option } from "effect";
import type { Scope } from "effect";
import type * as Action from "../Action.js";
import { Anyone } from "./actions.js";
import { type Refusal, Unauthenticated } from "./errors.js";
import type { CheckCallback, CheckRequests, CheckServices, ServiceOf } from "./checks.js";

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

/** Authorization runs only for protected actions, after authentication and before checks. */
export type Authorize<A extends Action.Any, R = never> = (
  action: A,
) => Effect.Effect<void, Refusal, R>;

/** An implementation's authorizer, erased. */
export type ErasedAuthorize = (action: Action.Any) => Effect.Effect<void, unknown, unknown>;

/** Each action of an implementation with its handler, as its builder made them. */
export type Bound = ReadonlyArray<readonly [Action.Any, ErasedHandler<unknown>]>;

/**
 * What a layer builds once per layer graph, under a key private to it: an implementation's
 * handlers, or its authorizer. Effect memoizes a layer by reference within one layer graph, so
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
 * Actions bound to their handlers and their authorizer: everything one `Action.implement` call
 * produced, one builder serving every surface.
 * The private fields make this class nominal: a structurally similar object, including one made by
 * spreading an implementation, is not an implementation. `R` maps each action name to its handler's
 * per-request requirements, and `~authorize`, which no action name can be, to its authorizer's; names
 * typed only as `string` absorb that key, and each then owes the authorizer's too. `EX` and `RX`
 * are the failures and services of its handlers' builder, and `EH` and `RH` of authorization's
 * builder. Public-only selections do not acquire authorization. A plain authorization callback
 * builds nothing.
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
  /** Type-only: each action's handler's per-request requirements, and the authorizer's. */
  declare readonly "~request": R;
  /** Type-only: what building its handlers fails with. */
  declare readonly "~buildError": EX;
  /** Type-only: what building its handlers needs. */
  declare readonly "~buildContext": RX;
  /** Type-only: what building its authorizer fails with. */
  declare readonly "~authorizeBuildError": EH;
  /** Type-only: what building its authorizer needs. */
  declare readonly "~authorizeBuildContext": RH;

  readonly #handlers: Memoized<Bound, EX, RX>;
  readonly #authorizer: Memoized<ErasedAuthorize, EH, RH>;

  constructor(
    /** The contracts this implementation answers. */
    readonly actions: ReadonlyArray<A>,
    /** Builds each action paired with its handler: its own builder, or the one it shares. */
    handlers: Memoized<Bound, EX, RX>,
    /** Builds its authorizer. */
    authorizer: Memoized<ErasedAuthorize, EH, RH>,
  ) {
    this.#handlers = handlers;
    this.#authorizer = authorizer;
  }

  /** Select contracts while retaining their handlers, authorization and shared builder. */
  static share(actions: ReadonlyArray<Action.Any>, app: AnyImplementation): AnyImplementation {
    const source = Implementation.own(app);

    return new Implementation(actions, source.#handlers, source.#authorizer);
  }

  /**
   * The key of what runs a call of `app`'s actions: its handlers' memoized layer's, which each
   * `implement` makes, so it is unique to the implementation. Every selection retains it.
   */
  static runKey(app: AnyImplementation): string {
    return Implementation.own(app).#handlers.key.key;
  }

  /**
   * The builders of `app`, its handlers' and its authorizer's, as a layer. Effect memoizes each
   * by reference within one layer graph, so every surface serving `app` there, and every
   * implementation sharing its builder, shares one run. Static, so it stays off the
   * public instance type.
   */
  static layerOf(app: AnyImplementation): Layer.Layer<never, unknown, unknown> {
    const source = Implementation.own(app);

    return app.actions.some((action) => action.caller !== Anyone)
      ? Layer.merge(source.#handlers.layer, source.#authorizer.layer)
      : source.#handlers.layer;
  }

  /**
   * The actions of `app` with their handlers, behind its authorizer, from the context
   * `layerOf(app)` provides.
   */
  static boundOf(app: AnyImplementation): Effect.Effect<Bound, never, unknown> {
    const { actions } = app;
    const source = Implementation.own(app);

    return Effect.gen(function* () {
      const bound = yield* source.#handlers.key;

      const before = actions.some((action) => action.caller !== Anyone)
        ? yield* source.#authorizer.key
        : () => Effect.void;

      return yield* Effect.forEach(
        bound.filter(([action]) => actions.includes(action)),
        ([action, handle]) =>
          Effect.map(
            Effect.forEach(action.checks, (check) => check),
            (checks) => [action, dispatch(action, handle, before, checks)] as const,
          ),
      );
    });
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

/** Options that may list actions of `A`, the shape every selecting surface's options share. */
export interface Selection<A extends Action.Any> {
  readonly actions?: ReadonlyArray<A> | undefined;
}

/**
 * The actions options `O` select, of `All`: those its `actions` lists when it always lists
 * them, and every one otherwise. Options whose `actions` may be absent, being optional or
 * a union with options lacking it, select every action at run time, so they narrow nothing.
 */
export type Selected<O, All extends Action.Any> = O extends {
  readonly actions: ReadonlyArray<infer A extends Action.Any>;
}
  ? A
  : All;

/**
 * The actions a client of options `O` offers methods for, of `All`: those `actions` may
 * list, wherever some member of `O` may list them, as each is present whether the list is
 * given or not; every one where no member lists any.
 */
export type Offered<O, All extends Action.Any> = [Listing<O>] extends [never]
  ? All
  : Extract<All, Listing<O> extends ReadonlyArray<infer A extends Action.Any> ? A : never>;

/** The lists of actions the members of `O` may give; none where no member gives one. */
type Listing<O> = O extends unknown ? NonNullable<O["actions" & keyof O]> : never;

/**
 * No key of any member of `O` beyond those of `Keys`, so a misspelled option is refused
 * rather than ignored: options inferred whole, as a type parameter, skip TypeScript's own
 * check, and `keyof` a union holds only the keys every member has.
 */
export type Known<O, Keys> = {
  readonly [K in Exclude<O extends unknown ? keyof O : never, keyof Keys>]?: never;
};

/**
 * The parameters of an optional options argument of type `O`: required where `O` names what
 * only a given argument holds, such as listed actions, so explicit type arguments cannot
 * narrow what an omitted argument leaves whole.
 */
export type OptionalUnless<O, Given> = {} extends O ? [options?: Given] : [options: Given];

/** A surface's implementations as a list. */
export const toList = (served: Served): ReadonlyArray<AnyImplementation> => Arr.ensure(served);

/** The actions of the implementations a surface serves. */
export type ActionOf<App> = App extends { readonly actions: ReadonlyArray<infer A> } ? A : never;

/** Whether `A` may be one of `Listed`: either is assignable to the other. */
type Matches<A extends Action.Any, Listed extends Action.Any> = Listed extends Action.Any
  ? [A] extends [Listed]
    ? true
    : [Listed] extends [A]
      ? true
      : never
  : never;

/**
 * The actions of `App` a surface given the actions `Listed` may serve, as `select` selects
 * them by identity: an action whose type either is assignable to, or is assigned by, one
 * listed. So an implementation typed wider than its contract, or a list typed wider than its
 * actions, an erased one included, still counts, and another contract of a listed name, which
 * the surface leaves out beside an action it serves, does not.
 */
export type Serving<App, Listed extends Action.Any> =
  ActionOf<App> extends infer A extends Action.Any
    ? A extends unknown
      ? // Each test is cheaper than the next, and the pairwise one is reached only by an
        // action named in `Listed` that is none of its members: one of `Listed` itself, or a
        // name it lacks, is decided without comparing the action with each listed one. The
        // constraint on `infer`, rather than `A extends Action.Any`, compares no action with
        // `Action.Any`, which cost as much as the rest of a surface over 400 actions.
        [A] extends [Listed]
        ? A
        : // An erased name may be any listed one, as an erased action matches any.
          string extends A["name"]
          ? A
          : [Extract<A["name"], Listed["name"]>] extends [never]
            ? never
            : [Matches<A, Listed>] extends [never]
              ? never
              : A
      : never
    : never;

/**
 * What each implementation among `App` owes per request where a surface serving the actions
 * `Listed` serves it: its authorizer's services, and the handlers' of the actions it serves.
 */
export type ServedRequest<App, Listed extends Action.Any> = App extends unknown
  ? RequestOf<App, Serving<App, Listed>>
  : never;

/** The implementations among `App` holding an action of `Listed`: those a surface builds. */
export type Holding<App, Listed extends Action.Any> = App extends unknown
  ? [Serving<App, Listed>] extends [never]
    ? never
    : App
  : never;

/**
 * Refuse an action of `listed` that `held` lacks, by identity, as a stale list, marking one
 * of a held name as another contract's.
 */
export const assertHeld = (
  why: string,
  listed: ReadonlyArray<Action.Any>,
  held: ReadonlyArray<Action.Any>,
): void => {
  const missing = listed.filter((action) => !held.includes(action));

  if (missing.length > 0) {
    const names = new Set(held.map(({ name }) => name));

    throw new Error(
      `Listed in actions, but ${why}: ${missing
        .map(({ name }) => (names.has(name) ? `${name} (another contract)` : name))
        .join(", ")}`,
    );
  }
};

/**
 * Each of `apps` narrowed to the actions `listed` holds, matched by identity, behind its own
 * authorization and sharing its builder; one holding none of them is
 * left out, and not built. All of `apps` as they are when nothing is listed. A listed action
 * none of them holds is refused, as a stale list or another contract of its name.
 */
export const select = (
  apps: ReadonlyArray<AnyImplementation>,
  listed: ReadonlyArray<Action.Any> | undefined,
): ReadonlyArray<AnyImplementation> => {
  if (listed === undefined) return apps;

  assertHeld(
    "no implementation holds it",
    listed,
    apps.flatMap((app) => app.actions),
  );

  return apps.flatMap((app) => {
    const own = app.actions.filter((action) => listed.includes(action));

    if (own.length === 0) return [];

    return own.length === app.actions.length ? [app] : [Implementation.share(own, app)];
  });
};

/** The protected members of a contract union. */
export type Protected<A extends Action.Any> = A extends unknown
  ? A["caller"] extends typeof Anyone
    ? never
    : A
  : never;

/**
 * The identity required by the contract, even when its handler never reads it. A `caller`
 * narrowed to `Anyone`, such as `Action.Any & { caller: typeof Anyone }`'s, which TypeScript
 * keeps as `typeof Anyone | (Key & typeof Anyone)`, requires none.
 */
export type AuthenticationOf<A extends Action.Any> = A["caller"] extends typeof Anyone
  ? never
  : ServiceOf<A["caller"]>;

/**
 * Per-request requirements of `App`'s authorization, checks and handler for each `A` it
 * implements: those of every name `A`'s may be, so a union or an erased name owes each it may
 * stand for.
 */
export type RequestOf<App, A extends Action.Any> = App extends {
  readonly "~request": infer R;
}
  ? A extends Action.Any
    ? [A["name"] & keyof R] extends [never]
      ? never
      :
          | R[A["name"] & keyof R]
          | (A["caller"] extends typeof Anyone ? never : R["~authorize" & keyof R])
          | AuthenticationOf<A>
          | CheckRequests<A>
    : never
  : never;

type OwnActions<App> = Extract<ActionOf<App>, Action.Any>;

/** Builder failures include authorization only if selected protected actions need it. */
export type BuildError<App, Listed extends Action.Any = OwnActions<App>> = App extends {
  readonly "~buildError": infer EX;
  readonly "~authorizeBuildError": infer EH;
}
  ? EX | ([Protected<Serving<App, Listed>>] extends [never] ? never : EH)
  : never;

/** What the builders of the handlers and authorization of the actions `Listed` read. */
export type BuilderContext<App, Listed extends Action.Any = OwnActions<App>> = App extends {
  readonly "~buildContext": infer RX;
  readonly "~authorizeBuildContext": infer RH;
}
  ? RX | ([Protected<Serving<App, Listed>>] extends [never] ? never : RH)
  : never;

/**
 * What a surface serving the actions `Listed` reads at startup: its builders' services and its
 * checks', acquired when it is built. What checks read per call stays a request requirement.
 */
export type BuildContext<App, Listed extends Action.Any = OwnActions<App>> =
  | BuilderContext<App, Listed>
  | CheckServices<Serving<App, Listed>>;

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

/**
 * Every action `apps` serve with its handler, behind its authorizer, as `provideHandlers` built
 * them.
 */
export const acquire = (
  apps: ReadonlyArray<AnyImplementation>,
): Effect.Effect<Bound, never, unknown> =>
  Effect.map(
    Effect.forEach(apps, (app) => Implementation.boundOf(app)),
    (bound) => bound.flat(),
  );

/**
 * Every action `apps` serve with its handler, behind its authorizer, their builders built as layers
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

/**
 * One action's handler behind its admission: a protected action's identity, then its
 * `authorize`, then its checks in order. These run outside the action's span, so what they
 * fail with is attributed to the surface rather than to a handler that never ran. Each call
 * has a scope of its own, on every surface: what `authorize`, the checks and the handler
 * acquire is released when the call ends, the handler's first, so no call needs a `Scope` of
 * its caller.
 */
const dispatch = (
  action: Action.Any,
  handle: ErasedHandler<unknown>,
  before: ErasedAuthorize,
  checks: ReadonlyArray<CheckCallback<unknown, unknown>>,
): ErasedHandler<unknown> => {
  // The contract's identity, on the span and on every log line the handler
  // writes, so a trace or a log can be filtered by action without parsing names.
  const attributes = {
    "action.name": action.name,
    "action.read_only": action.readOnly,
  };

  const authentication =
    action.caller === Anyone
      ? Effect.void
      : Effect.flatMap(Effect.serviceOption(action.caller), (actor) =>
          Option.isSome(actor) ? Effect.void : Effect.fail(new Unauthenticated()),
        );

  const authorization =
    action.caller === Anyone ? Effect.void : Effect.suspend(() => before(action));

  const operational = Effect.forEach(checks, (check) => Effect.suspend(() => check(action)), {
    discard: true,
  });

  return (input) => {
    const handled = Effect.withSpan(
      Effect.annotateLogs(
        Effect.suspend(() => handle(input)),
        attributes,
      ),
      action.name,
      { captureStackTrace: false, attributes },
    );

    return Effect.scoped(
      authentication.pipe(
        Effect.andThen(authorization),
        Effect.andThen(operational),
        Effect.andThen(handled),
      ),
    );
  };
};
