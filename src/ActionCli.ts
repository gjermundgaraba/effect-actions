import { Effect, type Scope } from "effect";
import { Command } from "effect/unstable/cli";
import type * as Action from "./Action.js";
import { command as makeCommand, type Options as CommandOptions } from "./internal/cli.js";
import { type Actions, selectNamed } from "./internal/actions.js";
import {
  dispatch,
  type HandlerContext,
  type Handlers,
  type HandlersContext,
  Implementation,
} from "./internal/implementation.js";

/**
 * The hook a local command runs before the selected handler. A CLI does not serialize
 * failures, so its refusal is a typed failure of the command effect rather than a
 * declared surface error; the native parser has already decoded the input.
 */
interface BeforeOptions<E, R> {
  readonly before?: (action: Action.Any) => Effect.Effect<void, E, R>;
}

/** Parsing, rendering and the pre-handler hook of one local command. */
export type Options<
  Output,
  E = never,
  R = never,
  Parameters extends Command.Command.Config = never,
> = CommandOptions<Output, Parameters> & BeforeOptions<E, R>;

/** Configuration for an aggregate group command. */
export interface GroupOptions<E = never, R = never> extends BeforeOptions<E, R> {
  /** Override the group command name. */
  readonly name?: string;
}

type Selected<G extends Actions, Name extends G["actions"][number]["name"]> = Extract<
  G["actions"][number],
  { readonly name: Name }
>;

type BoundHandler<Name extends string, A extends Action.Any, R> = Readonly<
  Record<Name, Action.Handler<A, R>>
>;

/**
 * Acquire the implementation in a scope of its own, run one action through the hook
 * and its handler, and release it: every local command, selected or grouped.
 */
const local = <A extends Action.Any, H extends Handlers<R>, EX, RX, EB, R>(
  app: Implementation<Actions, H, EX, RX>,
  action: A,
  // Typed as the option itself, not as the erased `Before`, so the hook's failure
  // type reaches this effect instead of being inferred as `unknown`.
  before: BeforeOptions<EB, R>["before"],
  input: A["input"]["Type"],
): Effect.Effect<
  A["success"]["Type"],
  A["errors"][number]["Type"] | EX | EB,
  Exclude<R | RX, Scope.Scope>
> =>
  Effect.scoped(
    Effect.flatMap(app.build, (handlers) =>
      dispatch<A, EB, R>(app.group, action, handlers, before)(input),
    ),
  );

/**
 * Project one explicitly selected local action into a native Effect CLI command.
 * The action name resolves against the bound group; no HTTP fallback exists.
 */
export const command = <
  G extends Actions,
  Name extends G["actions"][number]["name"],
  H extends BoundHandler<Name, Selected<G, Name>, HandlerContext<H, Name>>,
  EX,
  RX,
  EB = never,
  RB = never,
  Parameters extends Command.Command.Config = never,
>(
  app: Implementation<G, H, EX, RX>,
  name: Name,
  options?: Options<Selected<G, Name>["success"]["Type"], EB, RB, Parameters>,
) => {
  const action: Selected<G, Name> = selectNamed(
    app.group.actions,
    name,
    `action "${app.group.name}.${name}"`,
  );

  return makeCommand(
    action,
    (input) =>
      local<Selected<G, Name>, H, EX, RX, EB, HandlerContext<H, Name> | RB>(
        app,
        action,
        options?.before,
        input,
      ),
    options,
  );
};

/** Project every local action below its group namespace with default CLI options. */
export const group = <
  G extends Actions,
  H extends Handlers<HandlersContext<H>>,
  EX,
  RX,
  EB = never,
  RB = never,
>(
  app: Implementation<G, H, EX, RX>,
  options?: GroupOptions<EB, RB>,
) => {
  const commands = app.group.actions.map((action: G["actions"][number]) =>
    makeCommand(action, (input) =>
      local<typeof action, H, EX, RX, EB, HandlersContext<H> | RB>(
        app,
        action,
        options?.before,
        input,
      ),
    ),
  );

  return Command.make(options?.name ?? app.group.name).pipe(Command.withSubcommands(commands));
};
