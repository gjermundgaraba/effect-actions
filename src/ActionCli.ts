import { Effect, type Scope } from "effect";
import { Command } from "effect/unstable/cli";
import type * as Action from "./Action.js";
import { command as makeCommand, type Options as CommandOptions } from "./internal/cli.js";
import { assertDistinct } from "./internal/actions.js";
import {
  acquire,
  type AnyImplementation,
  type BuildContext,
  type BuildError,
  dispatch,
  type RequestContext,
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

/** Configuration for an aggregate command. */
export interface MakeOptions<E = never, R = never> extends BeforeOptions<E, R> {
  /** The aggregate command's name. */
  readonly name: string;
}

/** The implementation of `A` among `Apps`. */
type Selected<Apps extends ReadonlyArray<AnyImplementation>, A extends Action.Any> = Extract<
  Apps[number],
  { readonly action: A }
>;

/**
 * Acquire the implementation's source in a scope of its own, run one action through the
 * hook and its handler, and release it: every local command, selected or aggregated.
 */
const local = <App extends AnyImplementation, EB, RB>(
  app: App,
  // Typed as the option itself, not as the erased `Before`, so the hook's failure
  // type reaches this effect instead of being inferred as `unknown`.
  before: BeforeOptions<EB, RB>["before"],
  input: App["action"]["input"]["Type"],
): Effect.Effect<
  App["action"]["success"]["Type"],
  App["action"]["errors"][number]["Type"] | BuildError<App> | EB,
  Exclude<RequestContext<App> | BuildContext<App> | RB, Scope.Scope>
> =>
  // SAFETY: the source's failures and services are the implementation's `EX` and `RX`,
  // and the handler's are its `R`; `dispatch` keeps the action's own channels.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased source acquisition boundary.
  Effect.scoped(
    Effect.flatMap(acquire([app]), (handlerOf) =>
      dispatch<App["action"], EB, RB>(app.action, handlerOf(app), before)(input),
    ),
  ) as Effect.Effect<
    App["action"]["success"]["Type"],
    App["action"]["errors"][number]["Type"] | BuildError<App> | EB,
    Exclude<RequestContext<App> | BuildContext<App> | RB, Scope.Scope>
  >;

const select = <Apps extends ReadonlyArray<AnyImplementation>, A extends Action.Any>(
  apps: Apps,
  action: A,
): Selected<Apps, A> => {
  const app = apps.find((candidate): candidate is Selected<Apps, A> => candidate.action === action);

  if (app === undefined) throw new Error(`Action "${action.name}" has no implementation here`);

  return app;
};

/**
 * Project one action, selected by its contract from `apps`, into a native Effect CLI
 * command that runs its handler in process. No HTTP fallback exists.
 */
export const command = <
  const Apps extends ReadonlyArray<AnyImplementation>,
  A extends Apps[number]["action"],
  EB = never,
  RB = never,
  Parameters extends Command.Command.Config = never,
>(
  apps: readonly [...Apps],
  action: A,
  options?: Options<A["success"]["Type"], EB, RB, Parameters>,
) => {
  const app: Selected<Apps, A> = select(apps, action);

  return makeCommand(action, (input) => local(app, options?.before, input), options);
};

/** Project every implemented action as a subcommand of one aggregate command. */
export const make = <const Apps extends ReadonlyArray<AnyImplementation>, EB = never, RB = never>(
  apps: readonly [...Apps],
  options: MakeOptions<EB, RB>,
) => {
  assertDistinct(
    "command",
    apps.map((app) => app.action.name),
  );

  const commands = apps.map((app: Apps[number]) =>
    makeCommand(app.action, (input) => local(app, options.before, input)),
  );

  return Command.make(options.name).pipe(Command.withSubcommands(commands));
};
