import { Effect, Predicate, type Schema, type Scope } from "effect";
import { Command } from "effect/unstable/cli";
import type { HttpClient } from "effect/unstable/http";
import type * as Action from "./Action.js";
import { assertDistinct } from "./internal/actions.js";
import { kebab, command as makeCommand, type Options as CommandOptions } from "./internal/cli.js";
import type { Refusal } from "./internal/errors.js";
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
  type Hook,
  type Member,
  type RequestOf,
  type Served,
  servedActions,
  toList,
} from "./internal/implementation.js";

/**
 * How a local command is named and prints its result, and its hook. A CLI serializes no
 * failure, so a refusal is a typed failure of the command effect: the refusals the hook
 * fails with, `EB`.
 */
interface Options<Output, EB extends Refusal, R> extends CommandOptions<Output>, Hook<R, EB> {}

/** How a remote command is named and prints its result, and its native client options. */
interface RemoteOptions<Output> extends CommandOptions<Output>, ClientOptions {}

/** The name of an aggregate local command, and its hook. */
interface MakeOptions<EB extends Refusal, R> extends Hook<R, EB> {
  /** The aggregate command's name. */
  readonly name: string;
}

/** The name of an aggregate remote command, and its native client options. */
interface RemoteMakeOptions extends ClientOptions {
  /** The aggregate command's name. */
  readonly name: string;
}

/** Every option, erased: the public signatures restore them. */
type ErasedOptions = CommandOptions<Action.Any["success"]["Type"]> & Hook<unknown> & ClientOptions;

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

/** A native command calling `A` over HTTP, failing as its client method. */
type RemoteCommand<A extends Action.Any, Subcommands = never> = Command.Command<
  string,
  Subcommands,
  {},
  MethodError<A>,
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
 * Project one action into a native Effect CLI command, named after it in kebab case with
 * one flag per field of its input (`--user-id`), or `--input` taking the whole input as
 * JSON when it is not a struct. From an HTTP binding, the command calls the action over
 * HTTP through its `ActionHttpClient` method, on the host's `HttpClient`. From
 * implementations, it runs the handler in process.
 */
export function command<const H extends AnyHttp, A extends H["actions"][number]>(
  http: H,
  action: A,
  options?: RemoteOptions<A["success"]["Type"]>,
): RemoteCommand<A>;
export function command<
  const Apps extends Served,
  A extends ActionOf<Member<Apps>>,
  EB extends Refusal = never,
  RB = never,
>(
  apps: Apps,
  action: A,
  options?: Options<A["success"]["Type"], EB, RB>,
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
 * Project every action as a subcommand of one aggregate command, each named after its
 * action in kebab case: each action of an HTTP binding called over HTTP, or each
 * implemented action run in process.
 */
export function make<const H extends AnyHttp>(
  http: H,
  options: RemoteMakeOptions,
): RemoteCommand<H["actions"][number], {}>;
export function make<const Apps extends Served, EB extends Refusal = never, RB = never>(
  apps: Apps,
  options: MakeOptions<EB, RB>,
): LocalCommand<Member<Apps>, ActionOf<Member<Apps>>, EB, RB, {}>;
export function make(
  target: AnyHttp | Served,
  options: ErasedOptions & { readonly name: string },
): Command.Command<string, {}, {}, unknown, unknown> {
  const { baseUrl, transformClient } = options;

  const actions = isHttp(target) ? target.actions : servedActions("command", toList(target));

  assertDistinct(
    "command",
    actions.map((action) => kebab(action.name)),
  );

  const commands = isHttp(target)
    ? actions.map((action) => remote(target, action, { baseUrl, transformClient }))
    : actions.map((action) =>
        makeCommand(action, (input) =>
          local(select(toList(target), action), action, options.before, input),
        ),
      );

  // SAFETY: every subcommand runs or calls one action, so the aggregate's channels are
  // the unions `Local` and `RemoteCommand` state over them.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dynamic subcommand list.
  return Command.make(options.name).pipe(Command.withSubcommands(commands)) as never;
}
