import { Cause, Effect, Logger, Runtime, type Schema } from "effect";
import { Command } from "effect/cli";
import type { HttpClient, HttpClientError } from "effect/http";
import type * as Action from "./Action.js";
import { assertDistinct, assertKnown } from "./internal/actions.js";
import {
  type UserError,
  command as makeCommand,
  type Options as CommandOptions,
} from "./internal/cli.js";
import {
  type AnyHttp,
  assertInBinding,
  type Options as ClientOptions,
  methods,
} from "./internal/client.js";
import {
  acquire,
  type ActionOf,
  Implementation,
  type AnyImplementation,
  type BuildServices,
  type BuildError,
  assertHeld,
  type Holding,
  type Member,
  type RequestOf,
  select,
  type Known,
  type Selected,
  type SelectedOf,
  type Selection,
  type Served,
  toList,
} from "./internal/implementation.js";

/** How one command of `A` is named, takes its input and prints its result. */
export type { Options as CommandOptions } from "./internal/cli.js";

/**
 * What a command fails with when its action fails: Effect CLI's `UserError`, typed with the
 * action's failure as its `cause` and `reason`, and whose message is its JSON, which
 * `Command.run` prints on stderr. A type only: after `Command.run`, match the reason by its
 * tag, `Effect.catchReason("UserError", "UserNotFound", f)`.
 */
export type { UserError } from "./internal/cli.js";

/**
 * An aggregate command of the actions `A`: its name, the actions that are its subcommands,
 * and their options.
 */
export interface Options<A extends Action.Any = Action.Any> {
  /** The aggregate command's name. */
  readonly name: string;
  /**
   * The actions that are subcommands, among the binding's or the implementations' actions:
   * `[GetUser, RenameUser]`. Defaults to every action of them.
   */
  readonly actions?: ReadonlyArray<A> | undefined;
  /**
   * The options of each subcommand, keyed by its action's name, as `command` takes them:
   * `{ readFile: { positional: ["path"], render } }`.
   */
  readonly commands?: { readonly [K in A as K["name"]]?: CommandOptions<K> };
}

/** The `commands` any member of `O` may give. */
type CommandsOf<O> = O extends unknown
  ? "commands" extends keyof O
    ? NonNullable<O["commands" & keyof O]>
    : never
  : never;

/** The keys of any member of `C`. */
type KeysOf<C> = C extends unknown ? keyof C : never;

/** The options any member of `C` gives command `K`. */
type CommandOf<C, K> = C extends unknown ? (K extends keyof C ? C[K] : never) : never;

/**
 * No option, no command beyond the actions `A` of the target, and no command's option, beyond
 * `Keys`'s, in any member of `O`.
 */
type KnownOptions<O, Keys, A extends Action.Any> = Known<O, Keys> &
  ([CommandsOf<O>] extends [never]
    ? unknown
    : {
        readonly commands?: Known<
          CommandsOf<O>,
          { readonly [K in A["name"]]: CommandOptions<A> }
        > & {
          readonly [K in KeysOf<CommandsOf<O>>]?: Known<
            CommandOf<CommandsOf<O>, K>,
            CommandOptions<Action.Any>
          >;
        };
      });

/** The implementation of `A` among `App`. */
type Owning<App, A extends Action.Any> = App extends unknown
  ? A extends ActionOf<App>
    ? App
    : never
  : never;

/**
 * What one local command of `A` runs: its implementation's builder and authorization, then
 * its handler. Authorization may refuse and any handler fail with a built-in error, so
 * every one fails with `Action.BuiltIn` too.
 */
type Local<App, A extends Action.Any> = Effect.Effect<
  A["success"]["Type"],
  A["error"][number]["Type"] | BuildError<App, A> | Action.BuiltIn,
  RequestOf<App, A> | BuildServices<App, A>
>;

/**
 * Build the implementation's handlers for this call alone, run one action through its
 * authorization and handler, and release them: every local command, selected or aggregated.
 * The call's own scope, which every call has, closes first, so its finalizers run while the
 * builder's resources are still open; a local build never reuses one the host already made.
 */
const local = <App extends AnyImplementation, A extends Action.Any>(
  app: App,
  action: A,
  input: A["input"]["Type"],
): Local<App, A> => {
  // This action alone, with the shared builder: a protected sibling's authorization, which its
  // type does not owe, is never built for it.
  const own = Implementation.share([action], app);

  const call = Effect.flatMap(acquire([own]), (bound) => {
    const [, run] = bound.find(([candidate]) => candidate === action) ?? [];

    return run === undefined ? Effect.die(new Error(`No handler for ${action.name}`)) : run(input);
  });

  const built = call.pipe(Effect.provide(Implementation.layerOf(own), { local: true }));

  // SAFETY: the builders' failures and services are the implementation's `EX` and `RX`, the
  // handler's and authorization's services its entry of `R`. The handler fails with the
  // action's errors or a `BuiltIn`, and authorization with a refusal.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased handler boundary: the implementation's type restores every channel.
  return built as Local<App, A>;
};

/**
 * The one implementation of `action` among `apps`. One implemented twice is refused rather
 * than the first run; other actions' names are not this command's to check.
 */
const implementationOf = (
  apps: ReadonlyArray<AnyImplementation>,
  action: Action.Any,
): AnyImplementation => {
  const [app, ...others] = apps.filter((candidate) => candidate.actions.includes(action));

  if (app === undefined) throw new Error(`Action "${action.name}" has no implementation here`);

  if (others.length > 0) throw new Error(`Action "${action.name}" is implemented twice here`);

  return app;
};

/** One command running `action` in process, by its one implementation among `apps`. */
const inProcess = <A extends Action.Any>(
  apps: ReadonlyArray<AnyImplementation>,
  action: A,
  options: CommandOptions<A> | undefined,
) => {
  const app = implementationOf(apps, action);

  return makeCommand(action, (input) => local(app, action, input), options);
};

/**
 * One command calling `action` through the binding's client, made with `client` on the
 * host's `HttpClient`, whose failures include the binding's errors.
 */
const overHttp = <A extends Action.Any>(
  binding: AnyHttp,
  action: A,
  options: CommandOptions<A> | undefined,
  client: ClientOptions | undefined,
) => {
  assertInBinding(binding.actions, action);

  return makeCommand(
    action,
    (input) => Effect.flatMap(methods(binding, client), (methodOf) => methodOf(action)(input)),
    options,
    binding.error,
  );
};

/**
 * One aggregate command named `name`, a subcommand per action of `actions`, each made by
 * `project` with its options in `commands`: a local aggregate's and a remote one's.
 */
const aggregate = (
  name: string,
  actions: ReadonlyArray<Action.Any>,
  commands: NonNullable<Options["commands"]>,
  project: (
    action: Action.Any,
    options: CommandOptions<Action.Any> | undefined,
  ) => Command.Command<string, never, {}, unknown, unknown>,
) => {
  const subcommands = actions.map((action) => ({
    action,
    command: project(
      action,
      Object.hasOwn(commands, action.name) ? commands[action.name] : undefined,
    ),
  }));

  // An action served twice has one name twice, so this refuses it too.
  assertDistinct(
    "command",
    subcommands,
    ({ command }) => command.name,
    ({ action }) => `action ${action.name}`,
  );

  return Command.make(name).pipe(
    Command.withSubcommands(subcommands.map(({ command }) => command)),
  );
};

/** A command of any action of the target, so one record serves several selections. */
const commandsOf = (
  commands: Options["commands"],
  actions: ReadonlyArray<Action.Any>,
): NonNullable<Options["commands"]> => {
  const given = commands ?? {};

  assertKnown(
    "commands",
    Object.keys(given),
    actions.map((action) => action.name),
  );

  return given;
};

/**
 * Project one implemented action into a native Effect CLI command that runs its handler in
 * process, behind its implementation's authorization. It is named after the action in kebab
 * case with one flag per field of its input (`--user-id`), or `--input` taking the whole input
 * as JSON when it is not a struct. It needs what the authorization, its handler and its builder
 * need; the host provides the identity. It prints the result on stdout; a failure is a
 * `UserError`, which `Command.run` prints on stderr. `remoteCommand` calls a server instead.
 */
// Options are inferred whole, so a key of no command option, such as a remote command's
// `client`, is refused from a variable too, not only from a literal.
export function command<const Apps extends Served, A extends ActionOf<Member<Apps>>, const O = {}>(
  implementations: Apps,
  action: A,
  options?: O & NoInfer<CommandOptions<A>> & NoInfer<Known<O, CommandOptions<Action.Any>>>,
): Command.Command<
  string,
  never,
  {},
  UserError<Effect.Error<Local<Owning<Member<Apps>, A>, A>>>,
  Effect.Services<Local<Owning<Member<Apps>, A>, A>>
> {
  // SAFETY: the command runs `action` by its one implementation among `implementations`,
  // so its channels are what `Local` states for that implementation.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased implementation: the selected one's type restores the channels.
  return inProcess(toList(implementations), action, options) as never;
}

/**
 * Project one action of an HTTP binding into a native Effect CLI command, derived as `command`
 * derives it, that calls the action over HTTP through its `ActionHttp.client` method, made with
 * the `client` options on the host's `HttpClient`, and fails as the method does. It runs
 * nothing locally.
 */
export function remoteCommand<
  const H extends AnyHttp,
  A extends H["actions"][number],
  const O = {},
>(
  binding: H,
  action: A,
  options?: O &
    NoInfer<RemoteCommandOptions<A>> &
    NoInfer<Known<O, RemoteCommandOptions<Action.Any>>>,
): Command.Command<string, never, {}, HttpUserError<H, A>, HttpClient.HttpClient> {
  const { client, ...syntax } = options ?? {};

  return overHttp(binding, action, options === undefined ? undefined : syntax, client);
}

/** A remote command's options, its action `A`. */
export type RemoteCommandOptions<A extends Action.Any = Action.Any> = CommandOptions<A> & {
  /**
   * Its client's options, as `ActionHttp.client` takes them: `baseUrl`, and
   * `transformClient` for credentials. They reach this command's requests alone.
   */
  readonly client?: ClientOptions;
};

/** A remote aggregate command's options, its actions `A`. */
export type RemoteOptions<A extends Action.Any = Action.Any> = Options<A> & {
  /**
   * Every subcommand's client options, as `ActionHttp.client` takes them: `baseUrl`, and
   * `transformClient` for credentials. They reach this aggregate's requests alone.
   */
  readonly client?: ClientOptions;
};

/** What an aggregate command over binding `H` fails with, running its actions `A`. */
type HttpUserError<H extends AnyHttp, A extends Action.Any> = UserError<
  | A["error"][number]["Type"]
  | H["error"][number]["Type"]
  | Action.BuiltIn
  | HttpClientError.HttpClientError
  | Schema.SchemaError
>;

/**
 * Project every implemented action as a subcommand of one aggregate command, each named after
 * its action in kebab case and run in process. `commands` gives a subcommand the options
 * `command` takes, by action name. `remote` calls a server instead.
 */
// Without `actions`, every action is a command; options whose `actions` may be absent may run
// every action, so they type every command. `commands` is typed by every action of the
// implementations, so one record serves aggregates of different selections: a command of an
// action left out is unused.
export function make<
  const Apps extends Served,
  const O extends Selection<ActionOf<Member<Apps>>> = {},
>(
  implementations: Apps,
  options: O &
    NoInfer<Options<ActionOf<Member<Apps>>>> &
    NoInfer<KnownOptions<O, Options, ActionOf<Member<Apps>>>>,
): Command.Command<
  string,
  {},
  {},
  UserError<Effect.Error<Local<Holding<Member<Apps>, SelectedOf<O, Apps>>, SelectedOf<O, Apps>>>>,
  Effect.Services<Local<Holding<Member<Apps>, SelectedOf<O, Apps>>, SelectedOf<O, Apps>>>
> {
  const apps = toList(implementations);

  const commands = commandsOf(
    options.commands,
    apps.flatMap((app) => app.actions),
  );

  // The listed actions only, those an implementation holds, sharing its builder and
  // authorization.
  const served = select(apps, options.actions);

  const group = aggregate(
    options.name,
    served.flatMap((app) => app.actions),
    commands,
    (action, syntax) => inProcess(served, action, syntax),
  );

  // SAFETY: every subcommand runs one action by its implementation, so the aggregate's
  // channels are the unions of what `Local` states over them.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dynamic subcommand list.
  return group as never;
}

/**
 * Project every action of an HTTP binding as a subcommand of one aggregate command, derived as
 * `make` derives it, each calling its action over HTTP. `client` configures every
 * subcommand's client; `commands` gives a subcommand the options `command` takes.
 */
export function remote<
  const H extends AnyHttp,
  const O extends Selection<H["actions"][number]> = {},
>(
  binding: H,
  options: O &
    NoInfer<RemoteOptions<H["actions"][number]>> &
    NoInfer<KnownOptions<O, RemoteOptions<Action.Any>, H["actions"][number]>>,
): Command.Command<
  string,
  {},
  {},
  HttpUserError<H, Selected<O, H["actions"][number]>>,
  HttpClient.HttpClient
> {
  const listed = options.actions;

  if (listed !== undefined) assertHeld("the binding does not hold it", listed, binding.actions);

  const commands = commandsOf(options.commands, binding.actions);

  const group = aggregate(
    options.name,
    binding.actions.filter((action) => listed?.includes(action) ?? true),
    commands,
    (action, syntax) => overHttp(binding, action, syntax, options.client),
  );

  // SAFETY: every subcommand calls one action through the binding's client, so the
  // aggregate's channels are the unions of what a client method states over them.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dynamic subcommand list.
  return group as never;
}

/**
 * A program whose stdout carries only its results, such as a CLI feeding scripts or an MCP
 * subprocess, applied last, before `NodeRuntime.runMain`: the default logger of every layer
 * provided within writes to stderr, and a failure `runMain` would report, such as a defect or
 * a failure of a layer the host provides, is reported on stderr instead, once. A command's
 * own failure, which `Command.run` has printed, is not reported again. The exit code is the
 * one `runMain` gives: the failure's `Runtime.errorExitCode`, 1 by default, or 130 for an
 * interruption.
 */
export const logToStderr = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, never, R> =>
  self.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;

      const squashed = Cause.squash(cause);

      // Reported here, so `runMain` reports it no more, but exits as it would have. The
      // defect standing for it keeps the cause, for a teardown to read.
      const reported = Object.assign(new Error("Reported on stderr", { cause }), {
        [Runtime.errorReported]: false,
        [Runtime.errorExitCode]: Runtime.getErrorExitCode(squashed),
      });

      return Effect.andThen(
        Runtime.getErrorReported(squashed) ? Effect.logError(cause) : Effect.void,
        Effect.die(reported),
      );
    }),
    Effect.provideService(Logger.LogToStderr, true),
  );
