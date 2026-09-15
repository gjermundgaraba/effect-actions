import { Context, Effect, Layer } from "effect";
import type { Scope } from "effect";
import type * as Action from "../Action.js";

// Method syntax allows precisely typed handlers to satisfy this adapter-only
// executor. Dispatch must use the matching action's decoded input.
type Erased<R> = { handle(input: unknown): Effect.Effect<unknown, unknown, R> }["handle"];
export type Handlers<R> = Readonly<Record<string, Erased<R>>>;

/**
 * Adapter dispatch. `R` is a request requirement the adapter Layers declare
 * through `HttpRouter.Request.From<"Requires", R>`, so the host provides it per
 * request. This assertion does not prove service provenance: construction-context
 * isolation prevents build-only services from leaking into the request context.
 */
type Dispatch = (input: unknown) => Effect.Effect<unknown, unknown>;

export const handlerFor = <R>(table: Handlers<R>, action: Action.Any): Dispatch => {
  const handle = table[action.name];
  if (handle === undefined) throw new Error(`Missing handler: ${action.name}`);
  return handle as Dispatch;
};

interface HandlersId {
  readonly _tag: "effect-actions/Handlers";
}

let implementations = 0;

/**
 * Opaque implementation value. Only its type is exported publicly. `R` is
 * required per request; `EX`/`RX` describe handler acquisition at Layer build.
 * The private Layer is shared by both adapters through native Layer memoization.
 */
export class Implementation<Actions extends ReadonlyArray<Action.Any>, R, EX, RX> {
  readonly #handlers: Context.Service<HandlersId, Handlers<R>>;
  readonly #layer: Layer.Layer<HandlersId, EX, RX>;

  private constructor(
    readonly actions: Actions,
    handlers: Context.Service<HandlersId, Handlers<R>>,
    layer: Layer.Layer<HandlersId, EX, RX>,
  ) {
    this.#handlers = handlers;
    this.#layer = layer;
  }

  static make<Actions extends ReadonlyArray<Action.Any>, R, EX, RX>(
    actions: Actions,
    build: Effect.Effect<Handlers<R>, EX, RX>,
  ): Implementation<Actions, R, EX, Exclude<RX, Scope.Scope>> {
    const handlers = Context.Service<HandlersId, Handlers<R>>(
      `effect-actions/Handlers#${++implementations}`,
    );
    return new Implementation(actions, handlers, Layer.effect(handlers, build));
  }

  static register<Actions extends ReadonlyArray<Action.Any>, R, EX, RX, Out, E, In>(
    app: Implementation<Actions, R, EX, RX>,
    make: (handlers: Handlers<R>) => Layer.Layer<Out, E, In>,
  ): Layer.Layer<Out, E | EX, In | RX> {
    return Layer.unwrap(Effect.map(app.#handlers, make)).pipe(Layer.provide(app.#layer));
  }
}
