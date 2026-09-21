import { Effect, type Scope } from "effect";
import {
  type Actions as Contract,
  assertDistinct,
  assertName,
  type SchemaErrorPolicy,
} from "./internal/actions.js";
import { type Before, Implementation } from "./internal/implementation.js";
import type * as Action from "./Action.js";

/** The bound handlers of one group; opaque, see `Group.implement`. */
export type { Implementation } from "./internal/implementation.js";

/** Native HTTP schema-error policy, owned by a group rather than an action. */
export type { SchemaErrorPolicy } from "./internal/actions.js";

type HandlersFrom<Actions extends ReadonlyArray<Action.Any>> = {
  readonly [A in Actions[number] as A["name"]]: Action.Handler<A, any>;
};

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
    infer Http,
    infer Mcp
  >
    ? Action.Action<Name, Input, Output, readonly [...Own, ...Errors], Http, Mcp>
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
  readonly schemaError?: SchemaErrorPolicy<PolicyErrors>;
}

/** What `implement` accepts besides the handlers themselves. */
export interface ImplementOptions<Errors extends ReadonlyArray<Action.Codec>, R> {
  /**
   * Runs once per invocation before the selected handler, on every surface, with
   * the action contract it is about to run. It may fail only with the group's own
   * `errors`, because those are the failures every action of the group declares.
   * Its services are request-time requirements, like a handler's.
   */
  readonly before: (action: Action.Any) => Effect.Effect<void, Errors[number]["Type"], R>;
}

/** A named set of action contracts: what adapters serve and what `implement` binds. */
export interface Group<
  Name extends string,
  Actions extends ReadonlyArray<Action.Any>,
  PolicyErrors extends ReadonlyArray<Action.Codec> = ReadonlyArray<Action.Codec>,
  Errors extends ReadonlyArray<Action.Codec> = ReadonlyArray<Action.Codec>,
> extends Contract<Name, Actions, PolicyErrors> {
  /** Bind every handler at once, resolving build-time services once per adapter layer. */
  readonly implement: <H extends HandlersFrom<Actions>, EX = never, RX = never, RB = never>(
    build: H | Effect.Effect<H, EX, RX>,
    options?: ImplementOptions<Errors, RB>,
  ) => Implementation<
    Group<Name, Actions, PolicyErrors, Errors>,
    H,
    NoInfer<EX>,
    NoInfer<Exclude<RX, Scope.Scope>>,
    NoInfer<RB>
  >;
}

// `any` is a wildcard in this inference position: a group's own error schemas
// appear in `implement`'s options, which `unknown` would make unassignable.
/** Any group, with its actions and error schemas erased. */
export type Any = Group<string, ReadonlyArray<Action.Any>, ReadonlyArray<Action.Codec>, any>;

/** Define a group. Invalid or duplicate action and MCP names fail here, at definition time. */
export function make<
  const Name extends string,
  const Actions extends ReadonlyArray<Action.Any>,
  const Errors extends ReadonlyArray<Action.Codec> = [],
  const PolicyErrors extends ReadonlyArray<Action.Codec> = [],
>(
  options: Options<Name, Errors, PolicyErrors>,
  ...actions: Actions
): Group<Name, WithErrors<Actions, Errors>, PolicyErrors, Errors>;
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
    implement: <
      H extends HandlersFrom<ReadonlyArray<Action.Any>>,
      EX = never,
      RX = never,
      RB = never,
    >(
      build: H | Effect.Effect<H, EX, RX>,
      options?: ImplementOptions<ReadonlyArray<Action.Codec>, RB>,
    ) => {
      const built: Effect.Effect<H, EX, RX> = Effect.isEffect(build)
        ? build
        : Effect.succeed(build);

      const before: Before<RB> | undefined = options?.before;

      return Implementation.make<Any, H, EX, Exclude<RX, Scope.Scope>, RB>(
        group,
        // SAFETY: an adapter always acquires `build` within its own scope, so Scope is
        // internal to that acquisition and not an external BuildContext requirement.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Removes only the adapter-owned Scope from the public environment.
        built as Effect.Effect<H, EX, Exclude<RX, Scope.Scope> | Scope.Scope>,
        before,
      );
    },
  };

  return group;
}
