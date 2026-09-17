import { Context, Effect, Layer } from "effect";
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

export type Handlers<R> = Readonly<Record<string, Erased<R>>>;

// `R` is erased here because the adapter Layers declare it as a per-request
// requirement through `HttpRouter.Request.From<"Requires", R>`.
type Dispatch = (input: ErasedValue) => Effect.Effect<ErasedValue, ErasedValue>;

/** One acquired implementation and the actions its adapter serves. */
export interface Bound extends Served {
  readonly handle: (action: Action.Any) => Dispatch;
}

interface HandlersId {
  readonly _tag: "effect-actions/Handlers";
}

let implementations = 0;

/**
 * Opaque implementation value; only its type is public. `R` is required per
 * request, `EX`/`RX` describe handler acquisition at Layer build. Layer
 * memoization lets both adapters share one handler build per runtime.
 */
export class Implementation<A extends ReadonlyArray<Action.Any>, R, EX, RX> {
  // Held as an Effect rather than its invariant Service so `R` stays covariant.
  readonly #handlers: Effect.Effect<Handlers<R>, never, HandlersId>;
  readonly #layer: Layer.Layer<HandlersId, EX, RX>;

  private constructor(
    /** Adapters pair an implementation with its contract by this identity. */
    readonly group: Actions<string, A>,
    handlers: Effect.Effect<Handlers<R>, never, HandlersId>,
    layer: Layer.Layer<HandlersId, EX, RX>,
  ) {
    this.#handlers = handlers;
    this.#layer = layer;
  }

  static make<A extends ReadonlyArray<Action.Any>, R, EX, RX>(
    group: Actions<string, A>,
    build: Effect.Effect<Handlers<R>, EX, RX>,
  ): Implementation<A, R, EX, Exclude<RX, Scope.Scope>> {
    const handlers = Context.Service<HandlersId, Handlers<R>>(
      `effect-actions/Handlers#${++implementations}`,
    );

    return new Implementation(group, handlers, Layer.effect(handlers, build));
  }

  /**
   * Acquire exactly the implementations an adapter serves. Each resolves its
   * own handlers, so records are never merged across implementations.
   */
  static register<R, EX, RX, Out, E, In>(
    serving: ReadonlyArray<{
      readonly app: Implementation<ReadonlyArray<Action.Any>, R, EX, RX>;
      readonly actions: ReadonlyArray<Action.Any>;
    }>,
    make: (apps: ReadonlyArray<Bound>) => Layer.Layer<Out, E, In>,
  ): Layer.Layer<Out, E | EX, In | RX> {
    const [first, ...rest] = serving;

    if (first === undefined) return make([]);

    const bound = Effect.all(
      serving.map(({ app, actions }) =>
        Effect.map(app.#handlers, (handlers): Bound => ({
          group: app.group,
          actions,
          handle: (action) => {
            const handle = handlers[action.name];

            if (handle === undefined) throw new Error(`Missing handler: ${action.name}`);

            // SAFETY: handlers are stored erased; each adapter supplies the matching action's decoded input.
            return handle as Dispatch;
          },
        })),
      ),
    );

    return Layer.unwrap(Effect.map(bound, make)).pipe(
      Layer.provide(Layer.mergeAll(first.app.#layer, ...rest.map(({ app }) => app.#layer))),
    );
  }
}

export type AnyImplementation<A extends ReadonlyArray<Action.Any> = ReadonlyArray<Action.Any>> =
  Implementation<A, any, any, any>;

/** Per-request requirements of one implementation, or of a union of them. */
export type RequestContext<App> = App extends Implementation<any, infer R, any, any> ? R : never;

export type BuildError<App> = App extends Implementation<any, any, infer EX, any> ? EX : never;

export type BuildContext<App> = App extends Implementation<any, any, any, infer RX> ? RX : never;
