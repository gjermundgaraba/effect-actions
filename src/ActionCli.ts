import { Effect, Predicate, type Schema, type Scope } from "effect";
import { Command } from "effect/cli";
import type { HttpClient } from "effect/http";
import type * as Action from "./Action.js";
import { assertDistinct } from "./internal/actions.js";
import { kebab, command as makeCommand, type Options as CommandOptions } from "./internal/cli.js";
import { type AnyHttp, assertInBinding, type MethodError, methods } from "./internal/client.js";
import {
  acquire,
  type ActionOf,
  Implementation,
  type AnyImplementation,
  type BuildContext,
  type BuildError,
  type Member,
  type RequestOf,
  type Served,
  toList,
} from "./internal/implementation.js";

/** How one command of `A` is named, takes its input and prints its result. */
export type { Options as CommandOptions } from "./internal/cli.js";

/** An aggregate command of the actions `A`: its name, and its subcommands' options. */
export interface Options<A extends Action.Any = Action.Any> {
  /** The aggregate command's name. */
  readonly name: string;
  /**
   * The options of each subcommand, keyed by its action's name, as `command` takes them:
   * `{ readFile: { positional: ["path"], render } }`.
   */
  readonly commands?: { readonly [K in A as K["name"]]?: CommandOptions<K> };
}

/** The implementation of `A` among `App`. */
type Selected<App, A extends Action.Any> = App extends unknown
  ? A extends ActionOf<App>
    ? App
    : never
  : never;

/**
 * What one local command of `A` runs: its implementation's hook, then its handler. A CLI
 * serializes no failure, so a refusal or another built-in failure is a typed failure of the
 * command effect.
 */
type Local<App, A extends Action.Any> = Effect.Effect<
  A["success"]["Type"],
  A["errors"][number]["Type"] | BuildError<App> | Action.BuiltIn,
  Exclude<RequestOf<App, A> | BuildContext<App>, Scope.Scope>
>;

/** A native command running `Local`, or subcommands running it for each `A`. */
type LocalCommand<App, A extends Action.Any, Subcommands = never> = Command.Command<
  string,
  Subcommands,
  {},
  Effect.Error<Local<App, A>> | Schema.SchemaError,
  Effect.Services<Local<App, A>>
>;

/** A native command calling `A` of the binding `H` over HTTP, failing as its client method. */
type RemoteCommand<H extends AnyHttp, A extends Action.Any, Subcommands = never> = Command.Command<
  string,
  Subcommands,
  {},
  MethodError<A, H["errors"][number]>,
  HttpClient.HttpClient
>;

/**
 * Build the implementation's handlers for this call alone, run one action through its hook
 * and its handler, and release them: every local command, selected or aggregated. The call's
 * own scope closes first, so its finalizers run while the builder's resources are still open;
 * a local build never reuses one the host already made.
 */
const local = <App extends AnyImplementation, A extends Action.Any>(
  app: App,
  action: A,
  input: A["input"]["Type"],
): Local<App, A> => {
  const call = Effect.flatMap(acquire([app]), (bound) => {
    const [, run] = bound.find(([candidate]) => candidate === action) ?? [];

    return run === undefined ? Effect.die(`No handler for ${action.name}`) : run(input);
  });

  const built = call.pipe(
    Effect.scoped,
    Effect.provide(Implementation.layerOf(app), { local: true }),
  );

  // SAFETY: the builders' failures and services are the implementation's `EX` and `RX`, the
  // handler's and the hook's services its entry of `R`. The handler fails with the action's
  // errors or a `BuiltIn`; the hook with a refusal or an error every action it guards, this
  // one included, declares.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased handler boundary: the implementation's type restores every channel.
  return built as Local<App, A>;
};

/**
 * The one implementation of `action` among `apps`. One implemented twice is refused rather
 * than the first run; other actions' names are not this command's to check.
 */
const select = (apps: ReadonlyArray<AnyImplementation>, action: Action.Any): AnyImplementation => {
  const [app, ...others] = apps.filter((candidate) => candidate.actions.includes(action));

  if (app === undefined) throw new Error(`Action "${action.name}" has no implementation here`);

  if (others.length > 0) throw new Error(`Action "${action.name}" is implemented twice here`);

  return app;
};

/** One command calling `action` through the binding's client, on the host's `HttpClient`. */
const remote = (
  http: AnyHttp,
  action: Action.Any,
  options: CommandOptions<Action.Any> | undefined,
) => {
  assertInBinding(http, action);

  return makeCommand(
    action,
    (input) => Effect.flatMap(methods(http), (methodOf) => methodOf(action)(input)),
    options,
  );
};

// A binding declares its native `api`; an implementation never does.
const isHttp = (value: AnyHttp | Served): value is AnyHttp => Predicate.hasProperty(value, "api");

/** `action`'s command: called over HTTP from a binding, or run by its one implementation. */
const project = (
  target: AnyHttp | Served,
  action: Action.Any,
  options: CommandOptions<Action.Any> | undefined,
): Command.Command<string, never, {}, unknown, unknown> => {
  if (isHttp(target)) return remote(target, action, options);

  const app = select(toList(target), action);

  return makeCommand(action, (input) => local(app, action, input), options);
};

/**
 * Project one action into a native Effect CLI command, named after it in kebab case with
 * one flag per field of its input (`--user-id`), or `--input` taking the whole input as
 * JSON when it is not a struct. From an HTTP binding, the command calls the action over
 * HTTP through its `ActionHttp.client` method, on the host's `HttpClient`. From
 * implementations, it runs the handler in process, behind its implementation's `before`
 * hook; the host provides the identity.
 */
export function command<const H extends AnyHttp, A extends H["actions"][number]>(
  http: H,
  action: A,
  options?: CommandOptions<A>,
): RemoteCommand<H, A>;
export function command<const Apps extends Served, A extends ActionOf<Member<Apps>>>(
  implementations: Apps,
  action: A,
  options?: CommandOptions<A>,
): LocalCommand<Selected<Member<Apps>, A>, A>;
export function command(
  target: AnyHttp | Served,
  action: Action.Any,
  options?: CommandOptions<Action.Any>,
): Command.Command<string, never, {}, unknown, unknown> {
  return project(target, action, options);
}

/**
 * Project every action as a subcommand of one aggregate command, each named after its
 * action in kebab case: each action of an HTTP binding called over HTTP, or each
 * implemented action run in process. `commands` gives a subcommand the options `command`
 * takes, by action name.
 */
export function make<const Apps extends Served>(
  implementations: Apps,
  options: NoInfer<Options<ActionOf<Member<Apps>>>>,
): LocalCommand<Member<Apps>, ActionOf<Member<Apps>>, {}>;
export function make<const H extends AnyHttp>(
  http: H,
  options: NoInfer<Options<H["actions"][number]>>,
): RemoteCommand<H, H["actions"][number], {}>;
export function make(
  target: AnyHttp | Served,
  options: Options,
): Command.Command<string, {}, {}, unknown, unknown> {
  const commands = options.commands ?? {};

  const actions = isHttp(target) ? target.actions : toList(target).flatMap((app) => app.actions);

  // A key no action names is refused, so a stale option cannot outlive its action.
  const names = actions.map((action) => action.name);
  const unknown = Object.keys(commands).filter((key) => !names.includes(key));

  if (unknown.length > 0) throw new Error(`Unknown commands: ${unknown.join(", ")}`);

  const subcommands = actions.map((action) => {
    const own = Object.hasOwn(commands, action.name) ? commands[action.name] : undefined;

    return { action, name: own?.name ?? kebab(action.name), command: project(target, action, own) };
  });

  // An action served twice has one name twice, so this refuses it too.
  assertDistinct(
    "command",
    subcommands,
    ({ name }) => name,
    ({ action }) => `action ${action.name}`,
  );

  const group = Command.make(options.name).pipe(
    Command.withSubcommands(subcommands.map(({ command }) => command)),
  );

  // SAFETY: every subcommand runs or calls one action, so the aggregate's channels are
  // the unions `Local` and `RemoteCommand` state over them.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dynamic subcommand list.
  return group as never;
}
