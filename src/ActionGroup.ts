import { Effect, type Scope } from "effect";
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

export interface Group<Actions extends ReadonlyArray<Action.Any>> {
  readonly actions: Actions;
  /**
   * Bind every handler at once. Pass an Effect to resolve build-time services
   * once (`const users = yield* Users`); services yielded inside a handler are
   * request-scoped instead. Scoped acquisition lasts for the adapter runtime.
   */
  readonly implement: <H extends HandlersFrom<Actions>, EX = never, RX = never>(
    build: H | Effect.Effect<H, EX, RX>,
  ) => Implementation<Actions, HandlersContext<H>, EX, Exclude<RX, Scope.Scope>>;
}

/** Duplicate action and MCP names fail at definition time. */
export const make = <const Actions extends ReadonlyArray<Action.Any>>(
  ...actions: Actions
): Group<Actions> => {
  const names = new Set<string>();
  const toolNames = new Set<string>();
  for (const action of actions) {
    if (names.has(action.name)) throw new Error(`Duplicate action: ${action.name}`);
    names.add(action.name);
    if (action.mcp !== false) {
      if (toolNames.has(action.mcp.name)) throw new Error(`Duplicate MCP tool: ${action.mcp.name}`);
      toolNames.add(action.mcp.name);
    }
  }

  return {
    actions,
    implement: <H extends HandlersFrom<Actions>, EX = never, RX = never>(
      build: H | Effect.Effect<H, EX, RX>,
    ) => {
      const built: Effect.Effect<H, EX, RX> = Effect.isEffect(build)
        ? build
        : Effect.succeed(build);
      return Implementation.make<Actions, HandlersContext<H>, EX, RX>(actions, built);
    },
  };
};
