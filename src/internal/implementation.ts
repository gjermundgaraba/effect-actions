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
 * What every surface binds around the implementations it serves. `E` is the refusals the
 * hook fails with: the CLI infers it for its command's error type, where the other surfaces
 * declare every refusal.
 */
export interface Hook<R, E extends Refusal = Refusal> {
  /**
   * Runs once per call, after the input is decoded and before the selected handler, with
   * its action contract, so a policy reads `access` rather than the action name. It fails
   * with a refusal, answered exactly as a declared error. Its services are request-time
   * requirements, like a handler's.
   */
  readonly before?: ((action: Action.Any) => Effect.Effect<void, E, R>) | undefined;
}

/** A surface's hook, erased. */
type Before<R> = (action: Action.Any) => Effect.Effect<void, unknown, R>;

/** Per-request requirements of one handler. */
export type HandlerContext<H> = H extends (
  input: never,
) => Effect.Effect<infer _A, infer _E, infer R>
  ? R
  : never;

/** The acquired handlers of one implementation, under a key private to it. */
type HandlersKey = Context.Key<Handlers<unknown>, Handlers<unknown>>;

let implementations = 0;

/**
 * Actions bound to their handlers: everything one `Action.implement` call binds.
 *
 * The private fields make this class nominal: a structurally similar object,
 * including one made by spreading an implementation, is not an implementation.
 * `R` maps each action name to its handler's per-request requirements; `EX` and
 * `RX` are the failures and services of the builder.
 */
export class Implementation<
  A extends Action.Any,
  R extends { readonly [name: string]: unknown },
  EX,
  RX,
> {
  /** Type-only: each handler's per-request requirements, by action name. */
  declare readonly "~request": R;

  readonly #key: HandlersKey;
  readonly #layer: Layer.Layer<Handlers<unknown>, EX, RX>;

  constructor(
    /** The contracts this implementation answers. */
    readonly actions: ReadonlyArray<A>,
    build: Effect.Effect<Handlers<unknown>, EX, RX | Scope.Scope>,
  ) {
    // A string key is a service's identity, so it is unique to this implementation
    // even across copies of this module.
    this.#key = Context.Service<Handlers<unknown>>(
      `effect-actions/Implementation/${(implementations += 1)}/${Math.random().toString(36).slice(2)}`,
    );
    this.#layer = Layer.effect(this.#key, build);
  }

  /**
   * The builder of `app`, as a layer. Effect memoizes a layer by reference within one
   * build of the host's layers, so every adapter serving `app` shares one run. Static,
   * so it stays off the public instance type.
   */
  static layerOf<EX, RX>(
    app: Implementation<any, any, EX, RX>,
  ): Layer.Layer<Handlers<unknown>, EX, RX> {
    return Implementation.own(app).#layer;
  }

  /** The built handlers of `app`, from the context `layerOf(app)` provides. */
  static handlersOf(
    app: AnyImplementation,
  ): Effect.Effect<Handlers<unknown>, never, Handlers<unknown>> {
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

// `any` is a wildcard in these inference positions; `unknown` would fail to match.
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
export type ActionOf<App> = App extends Implementation<infer A, any, any, any> ? A : never;

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
export type RequestContext<App> =
  App extends Implementation<any, infer R, any, any> ? R[keyof R] : never;

/** Builder failures of the implementations a surface builds. */
export type BuildError<App> = App extends Implementation<any, any, infer EX, any> ? EX : never;

/** Builder requirements of the implementations a surface builds. */
export type BuildContext<App> = App extends Implementation<any, any, any, infer RX> ? RX : never;

/** An adapter's view of the acquired handler of one served action. */
export type HandlerOf = (action: Action.Any) => ErasedHandler<unknown>;

/** Every action `apps` serve, each once: a name served twice is refused. */
export const servedActions = (
  what: string,
  apps: ReadonlyArray<AnyImplementation>,
): ReadonlyArray<Action.Any> => {
  const actions = apps.flatMap((app) => app.actions);

  assertDistinct(
    what,
    actions.map((action) => action.name),
  );

  return actions;
};

/**
 * Provide `layer` the handlers of `apps`. Each implementation's layer is memoized, so its
 * builder runs once per host build however many adapters serve it.
 */
export const provideHandlers =
  (apps: ReadonlyArray<AnyImplementation>) =>
  <A, E, R>(layer: Layer.Layer<A, E, R>): Layer.Layer<A, unknown, unknown> => {
    const [first, ...rest] = [...new Set(apps.map((app) => Implementation.layerOf(app)))];

    return first === undefined ? layer : Layer.provide(layer, Layer.mergeAll(first, ...rest));
  };

/**
 * Look up the handler of any action `apps` serve, from the handlers `provideHandlers`
 * built. Every record is complete: `Action.implement` checks it.
 */
export const acquire = (
  apps: ReadonlyArray<AnyImplementation>,
): Effect.Effect<HandlerOf, never, unknown> =>
  Effect.map(
    Effect.forEach(apps, (app) => Implementation.handlersOf(app)),
    (records) => {
      const handlers = new Map(
        apps.flatMap((app, index) =>
          app.actions.map((action) => [action, records[index]?.[action.name]] as const),
        ),
      );

      return (action) => {
        const handle = handlers.get(action);

        if (handle === undefined) throw new Error(`No handler for ${action.name}`);

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
