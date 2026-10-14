import { Array as Arr, Cause, Context, Effect, Exit, Layer, Option, Schema } from "effect";
import type { Scope } from "effect";
import type * as Action from "./Action.js";
import { Anyone, assertAuthentication, type Proving } from "./caller.js";
import { projectedErrors } from "./declared.js";
import { assertDistinct, assertOnce } from "./names.js";
import { type Refusal, Unauthenticated } from "./errors.js";

// Why: Random, not a counter: two installed copies of this module would each count from zero and
// repeat each other's keys.
const uniqueKey = (): string => Math.random().toString(36).slice(2);

/** Decoded values at the dispatch boundary every surface shares. */
export type ErasedValue = Action.Any["input"]["Type"];

/**
 * A handler, erased. Method extraction makes the argument bivariant: a surface selects the
 * action before it invokes a handler, so its decoded input is the matching handler input, and
 * handlers are not widened at their public API.
 */
export type ErasedHandler<R> = {
  handle(input: ErasedValue): Effect.Effect<ErasedValue, ErasedValue, R>;
}["handle"];

export type Handlers<R> = Readonly<Record<string, ErasedHandler<R>>>;

/**
 * Authorization for protected contracts: it refuses, and fails with nothing else. It runs only for
 * protected actions, after authentication and before the handler.
 */
export type Authorize<A extends Action.Any, R = never> = (
  action: A,
) => Effect.Effect<void, Refusal, R>;

/** An implementation's authorizer, erased. */
export type ErasedAuthorize = (action: Action.Any) => Effect.Effect<void, unknown, unknown>;

/** Each action of an implementation with its handler, as its builder made them. */
export type Bound = ReadonlyArray<readonly [Action.Any, ErasedHandler<unknown>]>;

interface Memoized<S, E, R> {
  readonly key: Context.Key<S, S>;
  readonly layer: Layer.Layer<S, E, R>;
}

export const memoized = <S, E, R>(
  build: Effect.Effect<S, E, R>,
): Memoized<S, E, Exclude<R, Scope.Scope>> => {
  const key = Context.Service<S>(`effect-actions/Implementation/${uniqueKey()}`);

  return { key, layer: Layer.effect(key, build) };
};

/**
 * Actions bound to their handlers and their authorizer: everything one `Action.implement` call
 * produced, one builder serving every surface.
 * The private fields make this class nominal: a structurally similar object, including one made by
 * spreading an implementation, is not an implementation. Its type parameters may be written
 * out, as a package emitting declarations prints them: `A` its actions, `RequestServices` each
 * action name's handler's per-request requirements, `EX` and `RX` the failures and services of
 * its handlers' builder, `RA` what its authorizer reads per request, and `EAX` and `RAX` the
 * failures and services of the authorizer's builder. Public-only selections do not acquire
 * authorization. A plain authorization callback builds nothing.
 */
export class Implementation<
  A extends Action.Any,
  RequestServices extends { readonly [name: string]: unknown },
  EX,
  RX,
  RA = never,
  EAX = never,
  RAX = never,
> {
  /** Type-only: each action's handler's per-request requirements. */
  declare readonly "~request": RequestServices;
  /** Type-only: what building its handlers fails with. */
  declare readonly "~buildError": EX;
  /** Type-only: what building its handlers needs. */
  declare readonly "~buildServices": RX;
  /** Type-only: what its authorizer reads per request. */
  declare readonly "~authorizeRequest": RA;
  /** Type-only: what building its authorizer fails with. */
  declare readonly "~authorizeBuildError": EAX;
  /** Type-only: what building its authorizer needs. */
  declare readonly "~authorizeBuildServices": RAX;

  readonly #handlers: Memoized<Bound, EX, RX>;
  readonly #authorizer: Memoized<ErasedAuthorize, EAX, RAX>;

  constructor(
    /** The contracts this implementation answers. */
    readonly actions: ReadonlyArray<A>,
    /** Builds each action paired with its handler: its own builder, or the one it shares. */
    handlers: Memoized<Bound, EX, RX>,
    /** Builds its authorizer. */
    authorizer: Memoized<ErasedAuthorize, EAX, RAX>,
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

      return actions.flatMap((action) =>
        bound.flatMap(([held, handle]) =>
          held === action ? [[action, dispatch(action, handle, before)] as const] : [],
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

/**
 * Any implementation, with its actions and channels erased: the constraint of a helper generic over
 * implementations, `<App extends Action.AnyImplementation>`, whatever surface it passes them to;
 * `AnyImplementation<A>` is one of the actions `A`. Each parameter is covariant, so `unknown`
 * admits every implementation, while a value of this type owes `unknown`, which no surface can be
 * given.
 */
export type AnyImplementation<A extends Action.Any = Action.Any> = Implementation<
  A,
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Type-only requirements by action name, erased to the top type.
  { readonly [name: string]: unknown },
  unknown,
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
 * The middleware options `O` install, each a member of `L`: its `middleware` when always given,
 * an array of unknown length when it may be absent, which installs none or all of them, and
 * none otherwise.
 */
export type MiddlewareOf<O, L extends ReadonlyArray<unknown>> = O extends {
  readonly middleware: infer M extends L;
}
  ? M
  : O extends { readonly middleware?: infer M extends L | undefined }
    ? "middleware" extends keyof O
      ? ReadonlyArray<NonNullable<M>[number]>
      : []
    : [];

/** The actions options `O` select of the implementations `Apps` stand for. */
export type SelectedOf<O, Apps extends Served> = Selected<O, ActionOf<Member<Apps>>>;

/**
 * The actions a client of options `O` offers methods for, of `All`: those `actions` may
 * list, wherever some member of `O` may list them, as each is present whether the list is
 * given or not; every one where no member lists any.
 */
export type Offered<O, All extends Action.Any> = [Listing<O>] extends [never]
  ? All
  : Extract<All, Listing<O> extends ReadonlyArray<infer A extends Action.Any> ? A : never>;

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

export const toList = (served: Served): ReadonlyArray<AnyImplementation> => Arr.ensure(served);

/** The actions of the implementations a surface serves. */
export type ActionOf<App> = App extends { readonly actions: ReadonlyArray<infer A> } ? A : never;

type Matches<A extends Action.Any, Listed extends Action.Any> = Listed extends Action.Any
  ? [A] extends [Listed]
    ? true
    : [Listed] extends [A]
      ? true
      : never
  : never;

// Why: The tests before `Matches` only spare instantiations: an action is tested against the whole
// list first, and one whose name the list lacks is never compared pairwise; `infer A` binds the
// actions once.
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
      ? [A] extends [Listed]
        ? A
        : string extends A["name"]
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

const servedBy = (
  what: string,
  bound: ReadonlyArray<Action.Any>,
  apps: ReadonlyArray<AnyImplementation>,
  listed: ReadonlyArray<Action.Any> | undefined,
): ReadonlyArray<AnyImplementation> => {
  if (listed !== undefined) assertHeld("the binding does not hold it", listed, bound);

  const held = apps.flatMap((app) => app.actions);
  const served = select(apps, listed ?? bound.filter((action) => held.includes(action)));
  const actions = served.flatMap((app) => app.actions);

  // Why: Refused here, when the surface is called, not by the types: a type check leaves its key
  // deferred in a helper generic in its implementations or its binding, such as one serving
  // `[app, double]`, which then fails to compile.
  if (actions.length === 0 && listed === undefined && apps.length > 0) {
    const names = new Set(bound.map(({ name }) => name));

    throw new Error(
      `No action of these implementations is in this ${what}: ${
        held
          .map(({ name }) => (names.has(name) ? `${name} (another contract)` : name))
          .join(", ") || "none"
      }`,
    );
  }

  assertOnce("served action", actions);

  return served;
};

/**
 * What `ActionHttp.layer` and `ActionRpc.layer` serve, with the checks they share;
 * `authentication` is the binding's where a served action is protected.
 */
export const servingOf = <D extends Proving>(
  what: string,
  binding: {
    readonly actions: ReadonlyArray<Action.Any>;
    readonly authentication?: D | undefined;
  },
  served: Served,
  options: {
    readonly actions?: ReadonlyArray<Action.Any> | undefined;
    readonly middleware?: ReadonlyArray<{ readonly key: string }> | undefined;
  },
) => {
  const apps = servedBy(what, binding.actions, toList(served), options.actions);
  const actions = apps.flatMap((app) => app.actions);

  // Why: A binding spread with another descriptor, `{ ...binding, authentication }`, type-checks,
  // so what `make` checked no longer holds for it.
  assertAuthentication(actions, binding.authentication);
  assertDistinct("middleware", options.middleware ?? [], (key) => key.key);

  return {
    apps,
    actions,
    authentication: actions.some((action) => action.caller !== Anyone)
      ? binding.authentication
      : undefined,
  };
};

/** The protected members of a contract union. */
export type Protected<A extends Action.Any> = A extends unknown
  ? A["caller"] extends typeof Anyone
    ? never
    : A
  : never;

type ServiceOf<K> = K extends Context.Key<infer I, unknown> ? I : never;

// Why: A `caller` narrowed to `Anyone`, such as `Action.Any & { caller: typeof Anyone }`'s, is kept
// by TypeScript as `typeof Anyone | (Key & typeof Anyone)`, and must require no identity.
type AuthenticationOf<A extends Action.Any> = A["caller"] extends typeof Anyone
  ? never
  : ServiceOf<A["caller"]>;

/**
 * Per-request requirements of `App`'s authorization and handler for each `A` it
 * implements: those of every name `A`'s may be, so a union or an erased name owes each it may
 * stand for.
 */
export type RequestOf<App, A extends Action.Any> = App extends {
  readonly "~request": infer R;
  readonly "~authorizeRequest": infer RA;
}
  ? A extends Action.Any
    ? [A["name"] & keyof R] extends [never]
      ? never
      :
          | R[A["name"] & keyof R]
          | (A["caller"] extends typeof Anyone ? never : RA)
          | AuthenticationOf<A>
    : never
  : never;

type OwnActions<App> = Extract<ActionOf<App>, Action.Any>;

/**
 * What a surface serving the actions `Listed` of the implementations `App` fails with at startup:
 * their builders' and built authorizers' failures, an authorizer's only if a selected protected
 * action needs it.
 */
export type BuildError<App, Listed extends Action.Any = OwnActions<App>> = App extends {
  readonly "~buildError": infer EX;
  readonly "~authorizeBuildError": infer EAX;
}
  ? EX | ([Protected<Serving<App, Listed>>] extends [never] ? never : EAX)
  : never;

/**
 * What a surface serving the actions `Listed` of the implementations `App` reads at startup: their
 * builders' and built authorizers' services.
 */
export type BuildServices<App, Listed extends Action.Any = OwnActions<App>> = App extends {
  readonly "~buildServices": infer RX;
  readonly "~authorizeBuildServices": infer RAX;
}
  ? RX | ([Protected<Serving<App, Listed>>] extends [never] ? never : RAX)
  : never;

export const provideHandlers =
  (apps: ReadonlyArray<AnyImplementation>) =>
  <A, E, R>(layer: Layer.Layer<A, E, R>): Layer.Layer<A, unknown, unknown> => {
    const [first, ...rest] = apps.map((app) => Implementation.layerOf(app));

    return first === undefined ? layer : Layer.provide(layer, Layer.mergeAll(first, ...rest));
  };

export const builders = (
  apps: ReadonlyArray<AnyImplementation>,
): Layer.Layer<never, unknown, unknown> => Layer.empty.pipe(provideHandlers(apps));

export const acquire = (
  apps: ReadonlyArray<AnyImplementation>,
): Effect.Effect<Bound, never, unknown> =>
  Effect.map(
    Effect.forEach(apps, (app) => Implementation.boundOf(app)),
    (bound) => bound.flat(),
  );

export const built = (
  apps: ReadonlyArray<AnyImplementation>,
): Effect.Effect<Bound, unknown, unknown> => {
  const layers = apps.map((app) => Implementation.layerOf(app));
  const [first, ...rest] = layers;

  return Effect.gen(function* () {
    if (first === undefined) return [];

    // Why: `Layer.build` forks the memo map of the layer graph around the caller, and what a fork
    // builds first the surfaces of that graph build again. Built into the map itself, as
    // `HttpRouter` builds a middleware's dependencies, each builder runs once.
    const current = yield* Effect.serviceOption(Layer.CurrentMemoMap);
    const memoMap = Option.getOrElse(current, Layer.makeMemoMapUnsafe);
    const scope = yield* Effect.scope;
    const context = yield* Layer.buildWithMemoMap(Layer.mergeAll(first, ...rest), memoMap, scope);

    return yield* Effect.provideContext(acquire(apps), context);
  });
};

const dispatch = (
  action: Action.Any,
  handle: ErasedHandler<unknown>,
  before: ErasedAuthorize,
): ErasedHandler<unknown> => {
  const actionAttributes = {
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

  const validate = Schema.decodeUnknownEffect(Schema.toType(Schema.Union(projectedErrors(action))));

  // Why: A failure the action's errors reject, undeclared or breaking one of their checks, is the
  // call's defect on every surface, beside why they reject it and with its trace: logs and reports
  // then name it, where a surface encoding it named only the encoding's error.
  const asDefects = (
    reason: Cause.Fail<ErasedValue>,
    rejected: Cause.Cause<Schema.SchemaError>,
  ) => {
    const trace = Context.makeUnsafe<never>(reason.annotations);

    return [
      Cause.makeDieReason(reason.error).annotate(trace),
      Cause.makeDieReason(Cause.squash(rejected)).annotate(trace),
    ];
  };

  const declaredOrDefect = Effect.fnUntraced(function* (cause: Cause.Cause<ErasedValue>) {
    const reasons: Array<Cause.Reason<ErasedValue>> = [];

    for (const reason of cause.reasons) {
      if (Cause.isFailReason(reason)) {
        const validated = yield* Effect.exit(validate(reason.error));

        reasons.push(
          ...(Exit.isSuccess(validated) ? [reason] : asDefects(reason, validated.cause)),
        );
      } else {
        reasons.push(reason);
      }
    }

    return yield* Effect.failCause(Cause.fromReasons(reasons));
  });

  return (input) =>
    Effect.scoped(
      authentication.pipe(
        Effect.andThen(authorization),
        Effect.andThen(Effect.suspend(() => handle(input))),
        Effect.catchCause(declaredOrDefect),
      ),
    ).pipe(
      Effect.annotateLogs(actionAttributes),
      Effect.withSpan(action.name, { attributes: actionAttributes }, { captureStackTrace: false }),
    );
};
