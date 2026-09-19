import { Effect, type Scope } from "effect";
import { Command } from "effect/unstable/cli";
import type * as Action from "./Action.js";
import { command as makeCommand, type Options } from "./internal/cli.js";
import type { Actions } from "./internal/actions.js";
import {
  dispatch,
  type HandlerContext,
  type Handlers,
  type HandlersContext,
  Implementation,
} from "./internal/implementation.js";

export type { Options } from "./internal/cli.js";

/** Configuration for an aggregate group command. */
export interface GroupOptions {
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

const select = <G extends Actions, Name extends G["actions"][number]["name"]>(
  group: G,
  name: Name,
): Selected<G, Name> => {
  const action = group.actions.find(
    (candidate): candidate is Selected<G, Name> => candidate.name === name,
  );

  if (action === undefined) throw new Error(`Unknown action "${group.name}.${name}"`);

  return action;
};

const local = <
  G extends Actions,
  Name extends G["actions"][number]["name"],
  H extends BoundHandler<Name, Selected<G, Name>, HandlerContext<H, Name>>,
  EX,
  RX,
>(
  app: Implementation<G, H, EX, RX>,
  action: Selected<G, Name>,
  input: Selected<G, Name>["input"]["Type"],
): Effect.Effect<
  Selected<G, Name>["success"]["Type"],
  Selected<G, Name>["errors"][number]["Type"] | EX,
  Exclude<HandlerContext<H, Name> | RX, Scope.Scope>
> =>
  Effect.scoped(
    Effect.flatMap(app.build, (handlers) =>
      dispatch<Selected<G, Name>, HandlerContext<H, Name>>(app.group, action, handlers)(input),
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
  Parameters extends Command.Command.Config = never,
>(
  app: Implementation<G, H, EX, RX>,
  name: Name,
  options?: Options<Selected<G, Name>["success"]["Type"], Parameters>,
) => {
  const action = select(app.group, name);

  return makeCommand(action, (input) => local(app, action, input), options);
};

/** Project every local action below its group namespace with default CLI options. */
export const group = <G extends Actions, H extends Handlers<HandlersContext<H>>, EX, RX>(
  app: Implementation<G, H, EX, RX>,
  options?: GroupOptions,
) => {
  const commands = app.group.actions.map((action: G["actions"][number]) =>
    makeCommand(action, (input) =>
      Effect.scoped(
        Effect.flatMap(app.build, (handlers) =>
          dispatch<typeof action, HandlersContext<H>>(app.group, action, handlers)(input),
        ),
      ),
    ),
  );

  return Command.make(options?.name ?? app.group.name).pipe(Command.withSubcommands(commands));
};
