import { Effect, Predicate, type Schema, type Scope } from "effect";
import { Command } from "effect/unstable/cli";
import type { HttpClient } from "effect/unstable/http";
import type * as Action from "./Action.js";
import { command as makeCommand, type Options as CommandOptions } from "./internal/cli.js";
import {
  type AnyHttp,
  type MethodError,
  methods,
  type Options as ClientOptions,
} from "./internal/client.js";
import {
  acquire,
  type ActionOf,
  Implementation,
  type AnyImplementation,
  type BuildContext,
  type BuildError,
  dispatch,
  type Member,
  type RequestOf,
  type Served,
  servedActions,
  toList,
} from "./internal/implementation.js";

/**
 * The hook a local command runs before the selected handler. A CLI does not serialize
 * failures, so a refusal is a typed failure of the command effect; the native parser has
 * already decoded the input.
 */
interface Hook<EB, R> {
  readonly before?: (action: Action.Any) => Effect.Effect<void, EB, R>;
}

/**
 * Parsing, rendering and the hook of one local command. `Encoded` is the action's
 * encoded input, which parsed `parameters` must be to leave `input` out.
 */
export type Options<
  Output,
  EB = never,
  R = never,
  Parameters extends Command.Command.Config = never,
  Encoded = unknown,
> = CommandOptions<Output, Parameters, Encoded> & Hook<EB, R>;

/**
 * Parsing, rendering and the native client of one remote command: `baseUrl` and
 * `transformClient`, as `ActionHttpClient.make` takes them.
 */
export type RemoteOptions<
  Output,
  Parameters extends Command.Command.Config = never,
  Encoded = unknown,
> = CommandOptions<Output, Parameters, Encoded> & ClientOptions;

/** `Options`, erased: the public signatures restore them. */
type ErasedOptions = CommandOptions<Action.Any["success"]["Type"], Command.Command.Config> &
  Hook<unknown, unknown> &
  ClientOptions;

/** Configuration for an aggregate local command. */
export interface MakeOptions<EB = never, R = never> extends Hook<EB, R> {
  /** The aggregate command's name. */
  readonly name: string;
}

/** Configuration for an aggregate remote command. */
export interface RemoteMakeOptions extends ClientOptions {
  /** The aggregate command's name. */
  readonly name: string;
}

type ErasedMakeOptions = MakeOptions<unknown, unknown> & ClientOptions;

/** The implementation of `A` among `App`. */
type Selected<App, A extends Action.Any> = App extends unknown
  ? A extends ActionOf<App>
    ? App
    : never
  : never;

/** What one local command of `A` runs: its hook, then its handler. */
type Local<App, A extends Action.Any, EB, RB> = Effect.Effect<
  A["success"]["Type"],
  A["errors"][number]["Type"] | BuildError<App> | EB,
  Exclude<RequestOf<App, A> | BuildContext<App> | RB, Scope.Scope>
>;

/** A native command running `Local`, or subcommands running it for each `A`. */
type LocalCommand<App, A extends Action.Any, EB, RB, Subcommands = never> = Command.Command<
  string,
  Subcommands,
  {},
  A["errors"][number]["Type"] | BuildError<App> | EB | Schema.SchemaError,
  Exclude<RequestOf<App, A> | BuildContext<App> | RB, Scope.Scope>
>;

/** A native command calling `A` of the binding `H` over HTTP, failing as its client method. */
type RemoteCommand<H extends AnyHttp, A extends Action.Any, Subcommands = never> = Command.Command<
  string,
  Subcommands,
  {},
  MethodError<A, H["errors"][number]["Type"]>,
  HttpClient.HttpClient
>;

/**
 * Build the implementation's handlers in a scope of their own, run one action through the
 * hook and its handler, and release them: every local command, selected or aggregated.
 */
const local = <App extends AnyImplementation, A extends Action.Any, EB, RB>(
  app: App,
  action: A,
  // Typed as the option itself, not as the erased `Before`, so the hook's failure
  // type reaches this effect instead of being inferred as `unknown`.
  before: ((action: Action.Any) => Effect.Effect<void, EB, RB>) | undefined,
  input: A["input"]["Type"],
): Local<App, A, EB, RB> =>
  // SAFETY: the builder's failures and services are the implementation's `EX` and `RX`,
  // and the handler's are its entry of `R`; `dispatch` keeps the action's own channels.
  Effect.scoped(
    Effect.flatMap(acquire([app]), (handlerOf) =>
      dispatch<A, EB, RB>(action, handlerOf(action), before)(input),
    ).pipe(Effect.provide(Implementation.layerOf(app))),
  ) as Local<App, A, EB, RB>;

const select = (apps: ReadonlyArray<AnyImplementation>, action: Action.Any): AnyImplementation => {
  const app = apps.find((candidate) => candidate.actions.includes(action));

  if (app === undefined) throw new Error(`Action "${action.name}" has no implementation here`);

  return app;
};

/** One command calling `action` through the binding's client, with `options`' client. */
const remote = (http: AnyHttp, action: Action.Any, options: ErasedOptions | undefined) => {
  if (!http.actions.includes(action)) {
    throw new Error(`Action "${action.name}" is not in this HTTP binding`);
  }

  const { baseUrl, transformClient } = options ?? {};

  return makeCommand(
    action,
    (input) =>
      Effect.flatMap(methods(http, { baseUrl, transformClient }), (methodOf) =>
        methodOf(action)(input),
      ),
    options,
  );
};

// A binding declares its native `api`; an implementation never does.
const isHttp = (value: AnyHttp | Served): value is AnyHttp => Predicate.hasProperty(value, "api");

/**
 * Project one action into a native Effect CLI command. From an HTTP binding, the command
 * calls the action over HTTP through its `ActionHttpClient` method, on the host's
 * `HttpClient`. From implementations, it runs the handler in process.
 */
export function command<
  const H extends AnyHttp,
  A extends H["actions"][number],
  Parameters extends Command.Command.Config = never,
>(
  http: H,
  action: A,
  options?: RemoteOptions<A["success"]["Type"], Parameters, A["input"]["Encoded"]>,
): RemoteCommand<H, A>;
export function command<
  const Apps extends Served,
  A extends ActionOf<Member<Apps>>,
  EB = never,
  RB = never,
  Parameters extends Command.Command.Config = never,
>(
  apps: Apps,
  action: A,
  options?: Options<A["success"]["Type"], EB, RB, Parameters, A["input"]["Encoded"]>,
): LocalCommand<Selected<Member<Apps>, A>, A, EB, RB>;
export function command(
  target: AnyHttp | Served,
  action: Action.Any,
  options?: ErasedOptions,
): Command.Command<string, never, {}, unknown, unknown> {
  if (isHttp(target)) return remote(target, action, options);

  const app = select(toList(target), action);

  return makeCommand(action, (input) => local(app, action, options?.before, input), options);
}

/**
 * Project every action as a subcommand of one aggregate command: each action of an HTTP
 * binding called over HTTP, or each implemented action run in process.
 */
export function make<const H extends AnyHttp>(
  http: H,
  options: RemoteMakeOptions,
): RemoteCommand<H, H["actions"][number], {}>;
export function make<const Apps extends Served, EB = never, RB = never>(
  apps: Apps,
  options: MakeOptions<EB, RB>,
): LocalCommand<Member<Apps>, ActionOf<Member<Apps>>, EB, RB, {}>;
export function make(
  target: AnyHttp | Served,
  options: ErasedMakeOptions,
): Command.Command<string, {}, {}, unknown, unknown> {
  const { baseUrl, transformClient } = options;

  const commands = isHttp(target)
    ? target.actions.map((action) => remote(target, action, { baseUrl, transformClient }))
    : servedActions("command", toList(target)).map((action) =>
        makeCommand(action, (input) =>
          local(select(toList(target), action), action, options.before, input),
        ),
      );

  // SAFETY: every subcommand runs or calls one action, so the aggregate's channels are
  // the unions `Local` and `RemoteCommand` state over them.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dynamic subcommand list.
  return Command.make(options.name).pipe(Command.withSubcommands(commands)) as never;
}
