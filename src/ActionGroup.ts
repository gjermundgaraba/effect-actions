import { Effect, type Scope } from "effect";
import { type Actions as Contract, assertDistinct } from "./internal/actions.js";
import { Implementation } from "./internal/implementation.js";
import type * as Action from "./Action.js";

export type { Implementation } from "./internal/implementation.js";

type HandlersFrom<Actions extends ReadonlyArray<Action.Any>> = {
  readonly [A in Actions[number] as A["name"]]: Action.Handler<A, any>;
};

type HandlersContext<H> = {
  [K in keyof H]: H[K] extends (input: never) => Effect.Effect<infer _A, infer _E, infer R>
    ? R
    : never;
}[keyof H];

export interface Group<
  Name extends string,
  Actions extends ReadonlyArray<Action.Any>,
> extends Contract<Name, Actions> {
  /** The `HttpApiGroup` identifier, and so the OpenAPI tag and operation-ID prefix. */
  readonly name: Name;
  /**
   * Bind every handler at once. Pass an Effect to resolve build-time services
   * once (`const users = yield* Users`); services yielded inside a handler are
   * request-scoped instead. Scoped acquisition lasts for the adapter runtime.
   */
  readonly implement: <H extends HandlersFrom<Actions>, EX = never, RX = never>(
    build: H | Effect.Effect<H, EX, RX>,
    // NoInfer: called inline as an adapter argument, that parameter's `any`
    // must not flow back into `EX`/`RX`.
  ) => Implementation<Actions, HandlersContext<H>, NoInfer<EX>, NoInfer<Exclude<RX, Scope.Scope>>>;
}

export type Any = Group<string, ReadonlyArray<Action.Any>>;

/** Duplicate action and MCP names fail at definition time. */
export const make = <const Name extends string, const Actions extends ReadonlyArray<Action.Any>>(
  name: Name,
  ...actions: Actions
): Group<Name, Actions> => {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) throw new Error(`Invalid action group name: ${name}`);

  assertDistinct(
    "action",
    actions.map((action) => action.name),
  );
  assertDistinct(
    "MCP tool",
    actions.flatMap((action) => (action.mcp === false ? [] : [action.mcp.name])),
  );

  const group: Group<Name, Actions> = {
    name,
    actions,
    implement: <H extends HandlersFrom<Actions>, EX = never, RX = never>(
      build: H | Effect.Effect<H, EX, RX>,
    ) => {
      const built: Effect.Effect<H, EX, RX> = Effect.isEffect(build)
        ? build
        : Effect.succeed(build);

      return Implementation.make<Actions, HandlersContext<H>, EX, RX>(group, built);
    },
  };

  return group;
};
