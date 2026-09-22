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

/**
 * An adapter's erased view of the pre-handler hook one surface binds. It sees the
 * selected action contract, so a policy reads `access` rather than the action name.
 */
export type Before<R> = (action: Action.Any) => Effect.Effect<void, ErasedValue, R>;

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
 * Select the handler of a concrete action, once, when an adapter binds its acquired
 * record; `implement` has already refused a record without it. The returned function
 * invokes it: the surface's pre-handler hook runs first, outside the action's span, so a
 * refusal is attributed to the surface rather than to a handler that never ran.
 * `R` remains in the returned effect so transport layers cannot erase required
 * per-request services while assembling routes.
 */
export const dispatch = <A extends Action.Any, EB, R>(
  group: Actions,
  action: A,
  handlers: Handlers<R>,
  before: Before<R> | undefined,
) => {
  const handle = handlers[action.name];

  if (handle === undefined) throw new Error(`Missing handler: ${action.name}`);

  // The contract's identity, on the span and on every log line the handler
  // writes, so a trace or a log can be filtered by action without parsing names.
  const attributes = {
    "action.group": group.name,
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
      `${group.name}.${action.name}`,
      { captureStackTrace: false, attributes },
    );

    const invoked = before === undefined ? handled : Effect.flatMap(before(action), () => handled);

    // SAFETY: the selected action identifies the only handler invoked, whose
    // ActionGroup contract fixes this input, success and failure schema. The
    // hook fails only with the surface errors the adapter declares on `EB`.
    return invoked as Effect.Effect<A["success"]["Type"], A["errors"][number]["Type"] | EB, R>;
  };
};

// `any` is a wildcard in these inference positions; `unknown` would fail to match.
/** Any nominal implementation of `G`, with its record and channels erased. */
export type AnyImplementation<G extends Actions = Actions> = Implementation<G, any, any, any>;

/** The transports that serve a subset of a group's actions, by the contract flag that hides an action. */
export type Transport = "http" | "mcp";

/**
 * Names of the actions of `G` that `T` may serve. Only an action hidden by a
 * literal `false` is excluded; a flag decided at runtime keeps its requirements.
 */
export type ServedNames<G extends Actions, T extends Transport> = Exclude<
  G["actions"][number],
  T extends "http" ? { readonly http: false } : { readonly mcp: false }
>["name"];

/** Per-request requirements of the handlers `T` can invoke, or of a union of implementations. */
export type RequestContext<App, T extends Transport> =
  App extends Implementation<infer G, infer H, any, any>
    ? {
        readonly [K in Extract<ServedNames<G, T>, keyof H>]: HandlerContext<H, K>;
      }[Extract<ServedNames<G, T>, keyof H>]
    : never;

/** Handler-acquisition failures of the implementations `T` acquires, or of a union of them. */
export type BuildError<App, T extends Transport> =
  App extends Implementation<infer G, any, infer EX, any>
    ? [ServedNames<G, T>] extends [never]
      ? never
      : EX
    : never;

/** Handler-acquisition requirements of the implementations `T` acquires, or of a union of them. */
export type BuildContext<App, T extends Transport> =
  App extends Implementation<infer G, any, any, infer RX>
    ? [ServedNames<G, T>] extends [never]
      ? never
      : RX
    : never;
