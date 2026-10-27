import {
  Array as Arr,
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  References,
  Schema,
  Stream,
} from "effect";
import type { Scope } from "effect";

import type * as Action from "./Action.js";
import { Anyone, CallerKeyed } from "./caller.js";
import type { Keyed } from "./caller.js";
import { projectedErrors } from "./declared.js";
import { Unauthenticated } from "./errors.js";
import type { Refusal } from "./errors.js";
import type * as Event from "./Event.js";
import type { AnyEventImplementation, EventOf } from "./feed.js";
import { checkInput } from "./input-check.js";
import { assertOnce, heldOnce } from "./names.js";
import { reportedTo, streamReportedTo } from "./progress.js";
import type { Reporting } from "./progress.js";
import { elementOf } from "./stream.js";

// Why: Random, not a counter: two installed copies of this module would each count from zero and
// repeat each other's keys.
export const uniqueKey = (): string => Math.random().toString(36).slice(2);

/** Decoded values at the dispatch boundary every surface shares. */
export type ErasedValue = Action.Any["input"]["Type"];

/**
 * A handler as written, erased: its answer, or the stream of an action answering one. Method
 * extraction makes the argument bivariant: a surface selects the action before it invokes a
 * handler, so its decoded input is the matching handler input, and handlers are not widened at
 * their public API.
 */
export type WrittenHandler<R> = {
  handle(
    input: ErasedValue,
    reporting?: Reporting
  ):
    | Effect.Effect<ErasedValue, ErasedValue, R>
    | Stream.Stream<ErasedValue, ErasedValue, R>;
}["handle"];

export type Handlers<R> = Readonly<Record<string, WrittenHandler<R>>>;

/**
 * A handler behind its action's authentication, authorization and declared errors, as a surface
 * calls it. For an action answering a stream it succeeds at once with the call's stream, which
 * `elementsOf` reads, the refusals included. `reporting` is where its progress goes, ignored for
 * an action declaring no `progress`, so a surface may hand one to every call.
 */
export type ErasedHandler<R> = (
  input: ErasedValue,
  reporting?: Reporting
) => Effect.Effect<ErasedValue, ErasedValue, R>;

// Why: Only a handler the types were bypassed for answers otherwise than its contract says.
const notAStream = new Error(
  "A handler answered otherwise than its action's success declares"
);

/** The stream of a call of an action answering one, from its `ErasedHandler`'s answer. */
export const elementsOf = (
  answer: Effect.Effect<ErasedValue, ErasedValue, unknown>
): Stream.Stream<ErasedValue, ErasedValue, unknown> =>
  Stream.unwrap(
    Effect.filterOrElse(answer, Stream.isStream, () => Effect.die(notAStream))
  );

/** The answer of a handler of an action answering one value, a stream refused as a defect. */
export const answered = (
  answer: ReturnType<WrittenHandler<unknown>>
): Effect.Effect<ErasedValue, ErasedValue, unknown> =>
  Stream.isStream(answer) ? Effect.die(notAStream) : answer;

/**
 * `run` as a tool calls it, a tool answering one result: the elements of an action answering a
 * stream collected, in order, into one array once the stream ends.
 */
export const answeringWhole = (
  action: Action.Any,
  run: ErasedHandler<unknown>
): ErasedHandler<unknown> =>
  elementOf(action.success) === undefined
    ? run
    : (input, reporting) =>
        Stream.runCollect(elementsOf(run(input, reporting)));

/**
 * Authorization for protected contracts: it refuses, and fails with nothing else. It runs only for
 * protected actions, after authentication and before the handler.
 */
export type Authorize<A extends Action.Any, R = never> = (
  action: A
) => Effect.Effect<void, Refusal, R>;

/** An authorization rule over contracts `C`, erased: it refuses, or lets the call run. */
export type ErasedAuthorize<C = Action.Any> = (
  contract: C
) => Effect.Effect<void, unknown, unknown>;

/** Each action of an implementation with its handler, as `dispatch` makes it. */
export type Bound = ReadonlyArray<
  readonly [Action.Any, ErasedHandler<unknown>]
>;

/** Each action of an implementation with its handler as written, as its builder made them. */
export type Written = ReadonlyArray<
  readonly [Action.Any, WrittenHandler<unknown>]
>;

/** A build shared by every layer an implementation reaches, through the one key it is provided under. */
export interface Memoized<S, E, R> {
  readonly key: Context.Key<S, S>;
  readonly layer: Layer.Layer<S, E, R>;
}

export const memoized = <S, E, R>(
  build: Effect.Effect<S, E, R>
): Memoized<S, E, Exclude<R, Scope.Scope>> => {
  const key = Context.Service<S>(
    `effect-actions/Implementation/${uniqueKey()}`
  );

  return { key, layer: Layer.effect(key, build) };
};

/**
 * The builders of an implementation of `contracts` as one layer: what its builder made, and its
 * authorizer where a contract is protected, as only those need one.
 */
export const builderLayer = <S, E, R, SA, EA, RA>(
  contracts: ReadonlyArray<Pick<Action.Any, "caller">>,
  built: Pick<Memoized<S, E, R>, "layer">,
  authorizer: Memoized<SA, EA, RA>
): Layer.Layer<never, E | EA, R | RA> =>
  contracts.some((contract) => contract.caller !== Anyone)
    ? Layer.merge(built.layer, authorizer.layer)
    : built.layer;

/** What a surface throws for an implementation some other copy of this module made. */
export const notMadeHere = (module: "Action" | "Event"): Error =>
  new Error(
    `Not an implementation made by this ${module}.implement: pass the value implement returned, not a copy such as a spread; or effect-actions is installed twice`
  );

// Why: A failure the action's errors reject, undeclared or breaking one of their checks, is the
// call's defect on every surface, beside why they reject it and with its trace: logs and reports
// then name it, where a surface encoding it named only the encoding's error.
const asDefects = (
  reason: Cause.Fail<ErasedValue>,
  rejected: Cause.Cause<Schema.SchemaError>
) => {
  const trace = Context.makeUnsafe(reason.annotations);

  return [
    Cause.makeDieReason(reason.error).annotate(trace),
    Cause.makeDieReason(Cause.squash(rejected)).annotate(trace),
  ];
};

const dispatch = (
  action: Action.Any,
  handle: WrittenHandler<unknown>,
  before: ErasedAuthorize,
  keyed: Keyed | undefined
): ErasedHandler<unknown> => {
  const actionAttributes = {
    "action.name": action.name,
    "action.read_only": action.readOnly,
  };

  const authentication =
    action.caller === Anyone
      ? Effect.void
      : Effect.flatMap(Effect.serviceOption(action.caller), (actor) =>
          Option.isSome(actor)
            ? Effect.void
            : Effect.fail(new Unauthenticated())
        );

  const authorization =
    action.caller === Anyone
      ? Effect.void
      : Effect.suspend(() => before(action));

  const validate = Schema.decodeUnknownEffect(
    Schema.toType(Schema.Union(projectedErrors(action)))
  );

  const declaredOrDefect = Effect.fnUntraced(function* (
    cause: Cause.Cause<ErasedValue>
  ) {
    const reasons: Array<Cause.Reason<ErasedValue>> = [];

    for (const reason of cause.reasons) {
      if (Cause.isFailReason(reason)) {
        const validated = yield* Effect.exit(validate(reason.error));

        reasons.push(
          ...(Exit.isSuccess(validated)
            ? [reason]
            : asDefects(reason, validated.cause))
        );
      } else {
        reasons.push(reason);
      }
    }

    return yield* Effect.failCause(Cause.fromReasons(reasons));
  });

  const admitted = (input: ErasedValue) =>
    Effect.andThen(
      authentication,
      Effect.andThen(checkInput(action, input), authorization)
    );

  const span = { attributes: actionAttributes };
  const trace = { captureStackTrace: false };

  if (elementOf(action.success) !== undefined) {
    const streamed = (answer: ReturnType<WrittenHandler<unknown>>) =>
      Stream.isStream(answer) ? Stream.scoped(answer) : Stream.die(notAStream);

    return (input, sink) =>
      Effect.succeed(
        Stream.unwrap(
          Effect.map(admitted(input), () =>
            streamReportedTo(action.progress, sink, (reporting) =>
              streamed(handle(input, reporting))
            )
          )
        ).pipe(
          Stream.catchCause((cause) =>
            Stream.fromEffect(declaredOrDefect(cause))
          ),
          Stream.updateService(
            References.CurrentLogAnnotations,
            (annotations) => ({
              ...annotations,
              ...actionAttributes,
            })
          ),
          Stream.withSpan(action.name, { ...span, ...trace })
        )
      );
  }

  // Why: Provided whatever it is, an in-process call's `undefined` included, so a call made in a
  // handler is named by its own surface, not by the one its caller came through.
  return (input, sink) =>
    Effect.scoped(
      admitted(input).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            reportedTo(action.progress, sink, (reporting) =>
              answered(handle(input, reporting))
            )
          )
        ),
        Effect.provideService(CallerKeyed, keyed),
        Effect.catchCause(declaredOrDefect)
      )
    ).pipe(
      Effect.annotateLogs(actionAttributes),
      Effect.withSpan(action.name, span, trace)
    );
};

/**
 * Actions bound to their handlers and their authorizer: everything one `Action.implement` call
 * produced, one builder serving every surface. The private fields make this class nominal: a structurally similar object, including one made by
 * spreading an implementation, is not an implementation. Its type parameters may be written
 * out, as a package emitting declarations prints them: `A` its actions, `RequestServices` each
 * action name's handler's request-time requirements, `EX` and `RX` the failures and services of
 * its handlers' builder, `RA` what its authorizer reads per request, and `EAX` and `RAX` the
 * failures and services of the authorizer's builder.
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
  /** Type-only: each action's handler's request-time requirements. */
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

  /** The contracts this implementation answers. */
  readonly actions: readonly A[];
  readonly #handlers: Memoized<Written, EX, RX>;
  readonly #authorizer: Memoized<ErasedAuthorize, EAX, RAX>;

  constructor(
    actions: readonly A[],
    /** Builds each action paired with its handler: its own builder, or the one it shares. */
    handlers: Memoized<Written, EX, RX>,
    /** Builds its authorizer. */
    authorizer: Memoized<ErasedAuthorize, EAX, RAX>
  ) {
    this.actions = actions;
    this.#handlers = handlers;
    this.#authorizer = authorizer;
  }

  /** Select contracts while retaining their handlers, authorization and shared builder. */
  static share(
    actions: readonly Action.Any[],
    app: AnyImplementation
  ): AnyImplementation {
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
   * implementation sharing its builder, shares one run.
   */
  static layerOf(app: AnyImplementation): Layer.Layer<never, unknown, unknown> {
    const source = Implementation.own(app);

    return builderLayer(app.actions, source.#handlers, source.#authorizer);
  }

  /**
   * The actions of `app` with their handlers, behind its authorizer, from the context
   * `layerOf(app)` provides.
   */
  static boundOf(
    app: AnyImplementation,
    keyed: Keyed | undefined
  ): Effect.Effect<Bound, never, unknown> {
    const { actions } = app;
    const source = Implementation.own(app);

    return Effect.gen(function* () {
      const bound = yield* source.#handlers.key;

      const before = actions.some((action) => action.caller !== Anyone)
        ? yield* source.#authorizer.key
        : () => Effect.void;

      return actions.flatMap((action) =>
        bound.flatMap(([held, handle]) =>
          held === action
            ? [[action, dispatch(action, handle, before, keyed)] as const]
            : []
        )
      );
    });
  }

  /** `app`, if this copy of the module made it; another installed copy's cannot be read. */
  private static own<App extends AnyImplementation>(app: App): App {
    if (!(#handlers in app)) {
      throw notMadeHere("Action");
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
export type AnyImplementation<A extends Action.Any = Action.Any> =
  Implementation<
    A,
    // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Type-only requirements by action name, erased to the top type.
    { readonly [name: string]: unknown },
    unknown,
    unknown,
    unknown,
    unknown,
    unknown
  >;

/** What a surface serves: one implementation, of actions or of events, or a list of them. */
export type Served =
  | AnyImplementation
  | AnyEventImplementation
  | ReadonlyArray<AnyImplementation | AnyEventImplementation>;

/** What a surface serving no events takes: one action implementation, or a list of them. */
export type ServedActions = AnyImplementation | readonly AnyImplementation[];

/** The implementations `S` stands for. */
export type Member<S> = S extends ReadonlyArray<infer App> ? App : S;

/**
 * Options that may list actions and event types of `C`, the shape every selecting surface's
 * options share.
 */
export interface Selection<C extends Action.Any | Event.Any> {
  readonly actions?: readonly C[] | undefined;
}

/**
 * The actions options `O` select, of `All`: those its `actions` lists when it always lists
 * them, none where it lists event types alone, and every one otherwise. Options whose `actions`
 * may be absent, being optional or a union with options lacking it, select every action at run
 * time, so they narrow nothing.
 */
export type Selected<O, All extends Action.Any> = O extends {
  readonly actions: ReadonlyArray<infer C>;
}
  ? Extract<C, Action.Any>
  : All;

/** The event types options `O` select, of `All`, as `Selected` selects actions. */
export type SelectedEvents<O, All extends Event.Any> = O extends {
  readonly actions: ReadonlyArray<infer C>;
}
  ? Extract<C, Event.Any>
  : All;

/**
 * The middleware options `O` install, each a member of `L`: its `middleware` when always given,
 * an array of unknown length when it may be absent, which installs none or all of them, and
 * none otherwise.
 */
export type MiddlewareOf<O, L extends readonly unknown[]> = O extends {
  readonly middleware: infer M extends L;
}
  ? M
  : O extends { readonly middleware?: infer M extends L | undefined }
    ? "middleware" extends keyof O
      ? ReadonlyArray<NonNullable<M>[number]>
      : []
    : [];

/** The actions options `O` select of the implementations `Apps` stand for. */
export type SelectedOf<O, Apps extends Served> = Selected<
  O,
  ActionOf<Member<Apps>>
>;

/** The event types options `O` select of the implementations `Apps` stand for. */
export type SelectedEventsOf<O, Apps extends Served> = SelectedEvents<
  O,
  EventOf<Member<Apps>>
>;

/**
 * The actions or event types a client of options `O` offers, of `All`: those `actions` may
 * list, wherever some member of `O` may list them, as each is present whether the list is
 * given or not; every one where no member lists any.
 */
export type Offered<O, All extends Action.Any | Event.Any> = [
  Listing<O>,
] extends [never]
  ? All
  : Extract<All, Listing<O> extends ReadonlyArray<infer C> ? C : never>;

type Listing<O> = O extends unknown
  ? NonNullable<O["actions" & keyof O]>
  : never;

/**
 * No key of any member of `O` beyond those of `Keys`, so a misspelled option is refused
 * rather than ignored: options inferred whole, as a type parameter, skip TypeScript's own
 * check, and `keyof` a union holds only the keys every member has.
 */
export type Known<O, Keys> = {
  readonly [
    K in Exclude<O extends unknown ? keyof O : never, keyof Keys>
  ]?: never;
};

/**
 * The parameters of an optional options argument of type `O`: required where `O` names what
 * only a given argument holds, such as listed actions, so explicit type arguments cannot
 * narrow what an omitted argument leaves whole.
 */
export type OptionalUnless<O, Given> = {} extends O
  ? [options?: Given]
  : [options: Given];

/**
 * The action implementations among what a surface is given; `eventsOf` reads the event
 * implementations, by their tag.
 */
export const toList = (served: Served): readonly AnyImplementation[] =>
  Arr.ensure(served).filter(
    (app): app is AnyImplementation =>
      !Predicate.isTagged(app, "EventImplementation")
  );

/** The actions of the implementations a surface serves. */
export type ActionOf<App> = App extends {
  readonly actions: ReadonlyArray<infer A>;
}
  ? A
  : never;

type Matches<
  A extends Action.Any,
  Listed extends Action.Any,
> = Listed extends Action.Any
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

export const notHeld = {
  byImplementation: {
    why: "no implementation holds it",
    fix: "pass the implementation holding it, or list the contract it implements",
    holder: "they do not hold: list the one they hold",
  },
  byBinding: {
    why: "the binding does not hold it",
    fix: "add it to the binding's actions",
    holder: "it does not hold: list the one it holds",
  },
} as const;

/** The actions' names, joined; one whose name another listed contract shares is marked `(another contract)`. */
export const markingOthers = (
  actions: ReadonlyArray<Pick<Action.Any, "name">>,
  names: ReadonlySet<string>
) =>
  actions
    .map(({ name }) => (names.has(name) ? `${name} (another contract)` : name))
    .join(", ");

export const assertHeld = <C extends Pick<Action.Any, "name">>(
  { why, fix, holder }: (typeof notHeld)[keyof typeof notHeld],
  listed: readonly C[],
  held: readonly C[]
): void => {
  const missing = listed.filter((action) => !held.includes(action));

  if (missing.length > 0) {
    const names = new Set(held.map(({ name }) => name));
    const sameName = missing.some(({ name }) => names.has(name));

    throw new Error(
      `Listed in actions, but ${why}: ${markingOthers(missing, names)} (${fix}${sameName ? `; one marked (another contract) is a contract of that name ${holder}` : ""})`
    );
  }
};

/**
 * The implementations among `apps` holding what `listed` lists, each sharing its builder to hold
 * those alone, or every one where it lists none: action and event implementations alike, by the
 * contracts each `holds` and how it `share`s them.
 */
export const selectHeld = <App, C extends Pick<Action.Any, "name">>(
  apps: readonly App[],
  listed: readonly C[] | undefined,
  holds: (app: App) => readonly C[],
  share: (own: readonly C[], app: App) => App
): readonly App[] => {
  if (listed === undefined) {
    return apps;
  }

  assertHeld(notHeld.byImplementation, listed, apps.flatMap(holds));

  return apps.flatMap((app) => {
    const held = holds(app);
    const own = held.filter((contract) => listed.includes(contract));

    if (own.length === 0) {
      return [];
    }

    return own.length === held.length ? [app] : [share(own, app)];
  });
};

export const select = (
  apps: readonly AnyImplementation[],
  listed: readonly Action.Any[] | undefined
): readonly AnyImplementation[] =>
  selectHeld(
    apps,
    listed,
    (app) => app.actions,
    (own, app) => Implementation.share(own, app)
  );

export const servedBy = (
  what: string,
  bound: readonly Action.Any[],
  apps: readonly AnyImplementation[],
  listed: readonly Action.Any[] | undefined
): readonly AnyImplementation[] => {
  if (listed !== undefined) {
    assertHeld(notHeld.byBinding, listed, bound);
  }

  const held = apps.flatMap((app) => app.actions);

  const served = select(
    apps,
    listed ?? bound.filter((action) => held.includes(action))
  );

  const actions = served.flatMap((app) => app.actions);

  // Why: Refused here, when the surface is called, not by the types: a type check leaves its key
  // deferred in a helper generic in its implementations or its binding, such as one serving
  // `[app, double]`, which then fails to compile.
  if (actions.length === 0 && listed === undefined && apps.length > 0) {
    const names = new Set(bound.map(({ name }) => name));

    throw new Error(
      `No action of these implementations is in this ${what}: ${markingOthers(held, names) || "none"} (pass an implementation of a bound action, or bind one of these)`
    );
  }

  assertOnce("served action", actions, heldOnce);

  return served;
};

/** The protected members of a contract union, of actions or of events. */
export type Protected<A extends Pick<Action.Any, "caller">> = A extends unknown
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
export type BuildError<
  App,
  Listed extends Action.Any = OwnActions<App>,
> = App extends {
  readonly "~buildError": infer EX;
  readonly "~authorizeBuildError": infer EAX;
}
  ? EX | ([Protected<Serving<App, Listed>>] extends [never] ? never : EAX)
  : never;

/**
 * What a surface serving the actions `Listed` of the implementations `App` reads at startup: their
 * builders' and built authorizers' services.
 */
export type BuildServices<
  App,
  Listed extends Action.Any = OwnActions<App>,
> = App extends {
  readonly "~buildServices": infer RX;
  readonly "~authorizeBuildServices": infer RAX;
}
  ? RX | ([Protected<Serving<App, Listed>>] extends [never] ? never : RAX)
  : never;

/** Provide `builders`, implementations' builder layers, to a surface's layer. */
export const provideBuilders =
  (builders: ReadonlyArray<Layer.Layer<never, unknown, unknown>>) =>
  <A, E, R>(layer: Layer.Layer<A, E, R>): Layer.Layer<A, unknown, unknown> => {
    const [first, ...rest] = builders;

    return first === undefined
      ? layer
      : Layer.provide(layer, Layer.mergeAll(first, ...rest));
  };

export const provideHandlers = (apps: readonly AnyImplementation[]) =>
  provideBuilders(apps.map((app) => Implementation.layerOf(app)));

export const acquire = (
  apps: readonly AnyImplementation[],
  keyed: Keyed | undefined
): Effect.Effect<Bound, never, unknown> =>
  Effect.map(
    Effect.forEach(apps, (app) => Implementation.boundOf(app, keyed)),
    (bound) => bound.flat()
  );

/**
 * What `acquisition` reads, once `builders` are built into the layer graph around the caller, and
 * held by its scope.
 */
export const builtWith = <A>(
  builders: ReadonlyArray<Layer.Layer<never, unknown, unknown>>,
  acquisition: Effect.Effect<A, never, unknown>
): Effect.Effect<A, unknown, unknown> => {
  const [first, ...rest] = builders;

  return Effect.gen(function* () {
    if (first === undefined) {
      return yield* acquisition;
    }

    // Why: `Layer.build` forks the memo map of the layer graph around the caller, and what a fork
    // builds first the surfaces of that graph build again. Built into the map itself, as
    // `HttpRouter` builds a middleware's dependencies, each builder runs once.
    const current = yield* Effect.serviceOption(Layer.CurrentMemoMap);
    const memoMap = Option.getOrElse(current, Layer.makeMemoMapUnsafe);
    const scope = yield* Effect.scope;

    const context = yield* Layer.buildWithMemoMap(
      Layer.mergeAll(first, ...rest),
      memoMap,
      scope
    );

    return yield* Effect.provideContext(acquisition, context);
  });
};
