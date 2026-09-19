import { Effect } from "effect";
import type { Scope } from "effect";
import type * as Action from "../Action.js";
import type { Actions } from "./actions.js";

/** Decoded values at the adapter dispatch boundary. */
export type ErasedValue = Action.Any["input"]["Type"];

// Method extraction intentionally makes the argument bivariant. An adapter
// selects the action before it invokes a handler, so its decoded input is the
// matching handler input; handlers must not be widened at their public API.
type ErasedHandler<R> = {
  handle(input: ErasedValue): Effect.Effect<ErasedValue, ErasedValue, R>;
}["handle"];

/** An adapter's erased view of a record of handlers with request requirements `R`. */
export type Handlers<R> = Readonly<Record<string, ErasedHandler<R>>>;

/** Per-request requirements of the handler selected by an action name. */
export type HandlerContext<H, Name extends keyof H> = H[Name] extends (
  input: never,
) => Effect.Effect<infer _A, infer _E, infer R>
  ? R
  : never;

/** The union of per-request requirements declared by a handler record. */
export type HandlersContext<H> = {
  readonly [K in keyof H]: HandlerContext<H, K>;
}[keyof H];

/**
 * An acquired handler record for a group.
 *
 * The private field makes this class nominal: a structurally similar object,
 * including one made by spreading an implementation, is not an implementation.
 */
export class Implementation<G extends Actions, H, EX, RX> {
  readonly #build: Effect.Effect<H, EX, RX | Scope.Scope>;

  private constructor(
    /** The group whose exact handler record was built. */
    readonly group: G,
    build: Effect.Effect<H, EX, RX | Scope.Scope>,
  ) {
    this.#build = build;
  }

  /** Acquire the exact handler record in the adapter layer's scope. */
  get build(): Effect.Effect<H, EX, RX | Scope.Scope> {
    return this.#build;
  }

  static make<G extends Actions, H, EX, RX>(
    group: G,
    build: Effect.Effect<H, EX, RX | Scope.Scope>,
  ): Implementation<G, H, EX, RX> {
    return new Implementation(group, build);
  }
}

/**
 * Select and invoke a handler after an adapter has selected a concrete action.
 * `R` remains in the returned effect so transport layers cannot erase required
 * per-request services while assembling routes.
 */
export const dispatch = <A extends Action.Any, R>(
  group: Actions,
  action: A,
  handlers: Handlers<R>,
) => {
  const handle = handlers[action.name];

  if (handle === undefined) throw new Error(`Missing handler: ${action.name}`);

  return (
    input: A["input"]["Type"],
  ): Effect.Effect<A["success"]["Type"], A["errors"][number]["Type"], R> => {
    const invoked = Effect.withSpan(
      Effect.suspend(() => handle(input)),
      `${group.name}.${action.name}`,
      {
        captureStackTrace: false,
      },
    );

    // SAFETY: the selected action identifies the only handler invoked, whose
    // ActionGroup contract fixes this input, success and failure schema.
    return invoked as Effect.Effect<A["success"]["Type"], A["errors"][number]["Type"], R>;
  };
};

// `any` is a wildcard in these inference positions; `unknown` would fail to match.
/** Any nominal implementation of `G`, with its record and channels erased. */
export type AnyImplementation<G extends Actions = Actions> = Implementation<G, any, any, any>;

/** Per-request requirements of one implementation, or of a union of them. */
export type RequestContext<App> =
  App extends Implementation<any, infer H, any, any> ? HandlersContext<H> : never;

/** Handler-acquisition failures of one implementation, or of a union of them. */
export type BuildError<App> = App extends Implementation<any, any, infer EX, any> ? EX : never;

/** Handler-acquisition requirements of one implementation, or of a union of them. */
export type BuildContext<App> = App extends Implementation<any, any, any, infer RX> ? RX : never;
