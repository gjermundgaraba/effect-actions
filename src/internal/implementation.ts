import { Context, Effect, Layer } from "effect";
import type { Scope } from "effect";
import type { HttpRouter } from "effect/unstable/http";
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
 * An implementation's policy: how callers prove who they are, and whether they may call.
 * `A` is its actions, `RB` the hook's services.
 */
export interface Guard<A extends Action.Any, RB, Auth> {
  /**
   * `Authentication.make`'s middleware, or any native router middleware providing the
   * identity: how a remote caller proves who they are. HTTP surfaces run it before
   * decoding, around the routes that serve this implementation, and owe its request
   * requirements; local surfaces (CLI, Toolkit, MCP on stdio) leave identity to the host.
   */
  readonly authenticate?: Auth | undefined;
  /**
   * Runs once per call on every surface, after the input is decoded and before the
   * selected handler, with its action contract, so a policy reads `access` rather than
   * the action name. It fails with a refusal, answered exactly as a declared error. Its
   * services are request-time requirements, like a handler's.
   */
  readonly before?: ((action: A) => Effect.Effect<void, Refusal, RB>) | undefined;
}

/**
 * Native router middleware providing an identity per request, as `Authentication.make`
 * returns. Its own requirements stay per request, like a handler's: an HTTP surface
 * serving it owes them.
 */
export type Authenticator = HttpRouter.Middleware<any>;

/**
 * Any authenticator, as a surface runs it. Native middleware has its layer at run time
 * even while its type still asks for request requirements; the surface owes those.
 */
export interface ErasedAuthenticator {
  readonly layer: Layer.Layer<never, unknown, unknown>;
}

/** What an authenticator declares: what it provides and requires, per request and to build. */
type ConfigOf<Auth> = Auth extends HttpRouter.Middleware<infer Config> ? Config : never;

/** The identity services an authenticator provides. */
type Identity<Auth> = ConfigOf<Auth>["provides"];

/** An implementation's hook, erased. */
type Before = (action: Action.Any) => Effect.Effect<void, unknown, unknown>;

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
 * Actions bound to their handlers and their policy: everything one `Action.implement` call
 * binds.
 *
 * The private fields make this class nominal: a structurally similar object,
 * including one made by spreading an implementation, is not an implementation.
 * `R` maps each action name to its per-request requirements, its handler's and its hook's;
 * `EX` and `RX` are the failures and services of the builder; `Auth` is its authenticator.
 */
export class Implementation<
  A extends Action.Any,
  R extends { readonly [name: string]: unknown },
  EX,
  RX,
  Auth = never,
> {
  // Type-only fields, one per type parameter, so a type reads each by name.
  /** Type-only: each action's per-request requirements, by action name. */
  declare readonly "~request": R;
  /** Type-only: what building its handlers fails with. */
  declare readonly "~buildError": EX;
  /** Type-only: what building its handlers needs. */
  declare readonly "~buildContext": RX;
  /** Type-only: its authenticator. */
  declare readonly "~authenticate": Auth;

  readonly #key: HandlersKey;
  readonly #layer: Layer.Layer<Handlers<unknown>, EX, RX>;
  readonly #guard: Guard<Action.Any, unknown, ErasedAuthenticator>;

  constructor(
    /** The contracts this implementation answers. */
    readonly actions: ReadonlyArray<A>,
    build: Effect.Effect<Handlers<unknown>, EX, RX | Scope.Scope>,
    guard: Guard<Action.Any, unknown, ErasedAuthenticator> = {},
  ) {
    this.#guard = guard;
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
    app: Implementation<any, any, EX, RX, any>,
  ): Layer.Layer<Handlers<unknown>, EX, RX> {
    return Implementation.own(app).#layer;
  }

  /** The built handlers of `app`, from the context `layerOf(app)` provides. */
  static handlersOf(
    app: AnyImplementation,
  ): Effect.Effect<Handlers<unknown>, never, Handlers<unknown>> {
    return Implementation.own(app).#key;
  }

  /** The policy `app` was implemented with. */
  static guardOf(app: AnyImplementation): Guard<Action.Any, unknown, ErasedAuthenticator> {
    return Implementation.own(app).#guard;
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
export type AnyImplementation<A extends Action.Any = Action.Any> = Implementation<
  A,
  any,
  any,
  any,
  any
>;

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

/**
 * Per-request requirements of the implementations an HTTP surface serves: each one's
 * own, less the identity its authenticator provides.
 */
export type AuthenticatedContext<App> = App extends unknown
  ? Exclude<RequestContext<App>, Identity<AuthenticatorOf<App>>>
  : never;

// Each checks `App` itself, so a generic `App` resolves through its constraint.
/** What building the authenticators of `App` fails with, on the HTTP surfaces that run them. */
export type AuthenticatorError<App> = App extends { readonly "~authenticate": infer Auth }
  ? ConfigOf<Auth>["layerError"]
  : never;

/**
 * What the authenticators of `App` need, on the HTTP surfaces that run them: what the
 * native layer of each would require, their request requirements included.
 */
export type AuthenticatorContext<App> = App extends { readonly "~authenticate": infer Auth }
  ?
      | ConfigOf<Auth>["layerRequires"]
      | HttpRouter.Request.From<"Requires", ConfigOf<Auth>["requires"]>
      | HttpRouter.Request.From<"Error", ConfigOf<Auth>["error"]>
  : never;

/** The authenticator of each of `App`. */
type AuthenticatorOf<App> = App extends { readonly "~authenticate": infer Auth } ? Auth : never;

/** Builder failures of the implementations a surface builds. */
export type BuildError<App> = App extends { readonly "~buildError": infer EX } ? EX : never;

/** Builder requirements of the implementations a surface builds. */
export type BuildContext<App> = App extends { readonly "~buildContext": infer RX } ? RX : never;

/** An adapter's view of the acquired handler of one served action, behind its hook. */
export type HandlerOf = (action: Action.Any) => ErasedHandler<unknown>;

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
    const [first, ...rest] = [...new Set(apps.map((app) => Implementation.layerOf(app)))];

    return first === undefined ? layer : Layer.provide(layer, Layer.mergeAll(first, ...rest));
  };

/**
 * Look up the handler of any action `apps` serve, from the handlers `provideHandlers`
 * built, behind its implementation's hook. Every record is complete: `Action.implement`
 * checks it.
 */
export const acquire = (
  apps: ReadonlyArray<AnyImplementation>,
): Effect.Effect<HandlerOf, never, unknown> =>
  Effect.map(
    Effect.forEach(apps, (app) => Implementation.handlersOf(app)),
    (records) => {
      const handlers = new Map(
        apps.flatMap((app, index) =>
          app.actions.map((action) => {
            const handle = records[index]?.[action.name];

            return [
              action,
              handle === undefined
                ? undefined
                : dispatch(action, handle, Implementation.guardOf(app).before),
            ] as const;
          }),
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
 * One action's handler behind its hook. The hook runs first, outside the action's span,
 * so a refusal is attributed to the surface rather than to a handler that never ran.
 */
const dispatch = (
  action: Action.Any,
  handle: ErasedHandler<unknown>,
  before: Before | undefined,
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

/**
 * The distinct authenticators of `apps`, each with the implementations it guards; those
 * with none under `undefined`.
 */
export const byAuthenticator = (
  apps: ReadonlyArray<AnyImplementation>,
): ReadonlyMap<ErasedAuthenticator | undefined, ReadonlyArray<AnyImplementation>> => {
  const groups = new Map<ErasedAuthenticator | undefined, Array<AnyImplementation>>();

  for (const app of apps) {
    const authenticate = Implementation.guardOf(app).authenticate;
    groups.set(authenticate, [...(groups.get(authenticate) ?? []), app]);
  }

  return groups;
};
