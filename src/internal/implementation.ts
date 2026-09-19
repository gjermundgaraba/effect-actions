import { Effect, Layer } from "effect";
import type { Scope } from "effect";
import type * as Action from "../Action.js";
import type { Actions, Served } from "./actions.js";

/** Decoded action values after schema parsing, erased across actions at the adapter boundary. */
export type ErasedValue = Action.Any["input"]["Type"];

// Method syntax allows precisely typed handlers to satisfy this adapter-only
// executor. Dispatch must use the matching action's decoded input.
type Erased<R> = {
  handle(input: ErasedValue): Effect.Effect<ErasedValue, ErasedValue, R>;
}["handle"];

/** The erased handler record an adapter dispatches over. */
export type Handlers<R> = Readonly<Record<string, Erased<R>>>;

// Without `R`; see the cast in `register`.
type Dispatch = (input: ErasedValue) => Effect.Effect<ErasedValue, ErasedValue>;

/** One acquired implementation and the actions its adapter serves. */
export interface Bound extends Served {
  readonly handle: (action: Action.Any) => Dispatch;
}

/**
 * Opaque implementation value; only its type is public. `R` is required per
 * request, `EX`/`RX` describe handler acquisition at Layer build. The build may
 * also use `Scope`: the adapter layer supplies it.
 */
export class Implementation<G extends Actions, R, EX, RX> {
  readonly #build: Effect.Effect<Handlers<R>, EX, RX | Scope.Scope>;

  private constructor(
    /** Adapters pair an implementation with its contract by this identity. */
    readonly group: G,
    build: Effect.Effect<Handlers<R>, EX, RX | Scope.Scope>,
  ) {
    this.#build = build;
  }

  /**
   * `RX` is what the build needs beyond `Scope`: `register` runs it under
   * `Layer.unwrap`, in the adapter layer's scope, so `Scope` is always supplied.
   */
  static make<G extends Actions, R, EX, RX>(
    group: G,
    build: Effect.Effect<Handlers<R>, EX, RX | Scope.Scope>,
  ): Implementation<G, R, EX, RX> {
    return new Implementation(group, build);
  }

  /**
   * Acquire exactly the implementations an adapter serves, in the adapter
   * layer's scope. Each resolves its own handlers, so records are never merged
   * across implementations.
   */
  static register<R, EX, RX, Out, E, In>(
    serving: ReadonlyArray<{
      readonly app: Implementation<Actions, R, EX, RX>;
      readonly actions: ReadonlyArray<Action.Any>;
    }>,
    make: (apps: ReadonlyArray<Bound>) => Layer.Layer<Out, E, In>,
  ): Layer.Layer<Out, E | EX, In | RX> {
    const bound = Effect.forEach(serving, ({ app, actions }) =>
      Effect.map(app.#build, (handlers): Bound => ({
        group: app.group,
        actions,
        handle: (action) => {
          const handle = handlers[action.name];

          if (handle === undefined) throw new Error(`Missing handler: ${action.name}`);

          // SAFETY: drops only `R`. Each adapter's public `layer` signature restores it as
          // `HttpRouter.Request.From<"Requires", R>`, so these services are present per request.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erasure boundary: adapters dispatch handlers of every implementation through one record, so `R` cannot stay in the value type. The request context that supplies `R` at runtime is native Effect behavior, covered by tests/bindings.test.ts.
          const dispatch = handle as Dispatch;
          // The OpenAPI operation ID, so both transports label a call alike.
          const name = `${app.group.name}.${action.name}`;

          // Suspended so a handler that throws while building its effect fails inside the span.
          return (input) =>
            Effect.withSpan(
              Effect.suspend(() => dispatch(input)),
              name,
              { captureStackTrace: false },
            );
        },
      })),
    );

    return Layer.unwrap(Effect.map(bound, make));
  }
}

// `any` is a wildcard in these inference positions; `unknown` would fail to match.
/** Any implementation of `G`, with its channels erased. */
export type AnyImplementation<G extends Actions = Actions> = Implementation<G, any, any, any>;

/** Per-request requirements of one implementation, or of a union of them. */
export type RequestContext<App> = App extends Implementation<any, infer R, any, any> ? R : never;

/** Handler-acquisition failures of one implementation, or of a union of them. */
export type BuildError<App> = App extends Implementation<any, any, infer EX, any> ? EX : never;

/** Handler-acquisition requirements of one implementation, or of a union of them. */
export type BuildContext<App> = App extends Implementation<any, any, any, infer RX> ? RX : never;
