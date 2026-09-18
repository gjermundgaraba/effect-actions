import { Effect, type Scope } from "effect";
import { type Actions as Contract, assertDistinct, assertName } from "./internal/actions.js";
import { Implementation } from "./internal/implementation.js";
import type * as Action from "./Action.js";

/** The bound handlers of one group; opaque, see `Group.implement`. */
export type { Implementation } from "./internal/implementation.js";

// `any` is a wildcard here: each handler's own requirements are collected by
// `HandlersContext`; `unknown` would reject every handler that requires a service.
type HandlersFrom<Actions extends ReadonlyArray<Action.Any>> = {
  readonly [A in Actions[number] as A["name"]]: Action.Handler<A, any>;
};

type HandlersContext<H> = {
  [K in keyof H]: H[K] extends (input: never) => Effect.Effect<infer _A, infer _E, infer R>
    ? R
    : never;
}[keyof H];

/** Group-level errors join each action's own, so a shared set is declared once. */
type WithErrors<
  Actions extends ReadonlyArray<Action.Any>,
  Errors extends ReadonlyArray<Action.Codec>,
> = {
  readonly [K in keyof Actions]: Actions[K] extends Action.Action<
    infer Name,
    infer Input,
    infer Output,
    infer Own,
    infer Http
  >
    ? Action.Action<Name, Input, Output, readonly [...Own, ...Errors], Http>
    : never;
};

/** What `make` needs to define a group. */
export interface Options<
  Name extends string,
  Errors extends ReadonlyArray<Action.Codec>,
  PolicyErrors extends ReadonlyArray<Action.Codec>,
> {
  /** The `HttpApiGroup` identifier, and so the OpenAPI tag and operation-ID prefix. */
  readonly name: Name;
  /** Failures every action of the group may have, added to each action's own. */
  readonly errors?: Errors;
  /** How HTTP answers failed decoding or encoding of these actions; MCP keeps its native answers. */
  readonly schemaError?: Action.SchemaErrorPolicy<PolicyErrors>;
}

/** A named set of action contracts: what adapters serve and what `implement` binds. */
export interface Group<
  Name extends string,
  Actions extends ReadonlyArray<Action.Any>,
  PolicyErrors extends ReadonlyArray<Action.Codec> = ReadonlyArray<Action.Codec>,
> extends Contract<Name, Actions, PolicyErrors> {
  /**
   * Bind every handler at once. Pass an Effect to resolve build-time services
   * (`const users = yield* Users`); services yielded inside a handler are
   * request-scoped instead. The Effect runs once per adapter layer that serves
   * this implementation, and scoped acquisition lasts as long as that layer.
   */
  readonly implement: <H extends HandlersFrom<Actions>, EX = never, RX = never>(
    build: H | Effect.Effect<H, EX, RX>,
    // NoInfer: called inline as an adapter argument, that parameter's `any`
    // must not flow back into `EX`/`RX`.
  ) => Implementation<
    Group<Name, Actions, PolicyErrors>,
    HandlersContext<H>,
    NoInfer<EX>,
    NoInfer<Exclude<RX, Scope.Scope>>
  >;
}

/** Any group, with its actions erased. */
export type Any = Group<string, ReadonlyArray<Action.Any>>;

/** Define a group. Invalid or duplicate action and MCP names fail here, at definition time. */
export function make<
  const Name extends string,
  const Actions extends ReadonlyArray<Action.Any>,
  const Errors extends ReadonlyArray<Action.Codec> = [],
  const PolicyErrors extends ReadonlyArray<Action.Codec> = [],
>(
  options: Options<Name, Errors, PolicyErrors>,
  ...actions: Actions
): Group<Name, WithErrors<Actions, Errors>, PolicyErrors>;
export function make(
  options: Options<string, ReadonlyArray<Action.Codec>, ReadonlyArray<Action.Codec>>,
  ...declared: ReadonlyArray<Action.Any>
): Any {
  const { name } = options;

  assertName("action group name", name);

  const actions = declared.map((action) => ({
    ...action,
    errors: [...action.errors, ...(options.errors ?? [])],
  }));

  assertDistinct(
    "action",
    actions.map((action) => action.name),
  );
  assertDistinct(
    "MCP tool",
    actions.flatMap((action) => (action.mcp === false ? [] : [action.mcp.name])),
  );

  const group: Any = {
    name,
    actions,
    schemaError: options.schemaError,
    implement: <H extends HandlersFrom<ReadonlyArray<Action.Any>>, EX = never, RX = never>(
      build: H | Effect.Effect<H, EX, RX>,
    ) => {
      const built: Effect.Effect<H, EX, RX> = Effect.isEffect(build)
        ? build
        : Effect.succeed(build);

      return Implementation.make<Any, HandlersContext<H>, EX, RX>(group, built);
    },
  };

  return group;
}
