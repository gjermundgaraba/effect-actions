import { Cause, Effect, Logger, Runtime, type Schema } from "effect";
import { Command } from "effect/cli";
import type { HttpClient, HttpClientError } from "effect/http";
import type * as Action from "../contract/Action.js";
import {
  assertDistinct,
  assertKnown,
  projectedErrors,
  bindingErrors,
  type Declaring,
} from "../contract/rules.js";
import type { VerifierError } from "../authentication/provider.js";
import {
  type UserError,
  command as makeCommand,
  failingAsDerived,
  type Options as CommandOptions,
} from "./commands.js";
import {
  type Any as AnyHttp,
  client as httpClient,
  type ClientOptions,
} from "../http/ActionHttp.js";
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
} from "../contract/implementation.js";

export type { Options as CommandOptions } from "./commands.js";

export type { UserError } from "./commands.js";

// Why: The three fields `toUserError` reads, which the bindings of `ActionHttp.make` and
// `ActionRpc.make` both have: a command of your own calls through either.
interface AnyBinding extends Declaring {
  readonly actions: ReadonlyArray<Action.Any>;
}

/**
 * Make a command of your own fail as a derived command does. Give it what the command calls, the
 * binding of `ActionHttp.client` or `ActionRpc.client`, or the actions of `Action.client`, and pipe the command's
 * whole Effect through it: a failure that is a declared error, the binding's and its
 * authentication's included, or a built-in one becomes a `UserError` whose message is its JSON, and any other, a transport
 * failure for one, a `UserError` naming it and the causes beneath it. An Effect CLI error, your
 * own `new CliError.UserError({ cause, userMessage })` included, passes through as it is. To
 * add context, such as how far a batch got, print it before this in the pipe, with
 * `Effect.tapError(() => Console.error(…))`: a `UserError` wrapped around the result would
 * replace its JSON.
 */
export const toUserError = (calls: AnyBinding | ReadonlyArray<Action.Any>) =>
  "actions" in calls
    ? failingAsDerived(calls.actions, (action) => bindingErrors(action, calls))
    : failingAsDerived(calls, (action) => projectedErrors(action));

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
  /**
   * Commands of your own beside the derived ones, as `Command.withSubcommands` takes them:
   * `[importLinks]`, each made with Effect CLI's `Command.make`. One fails as you make it fail:
   * with a `CliError.UserError` for `Command.run` to print its `userMessage` on stderr. Written
   * in the call, or in options held with `satisfies` this type, the list adds its commands'
   * failures and services to the aggregate's type; in options annotated with this type, it adds
   * none.
   */
  readonly subcommands?: Subcommands | undefined;
}

type Subcommands = ReadonlyArray<Command.Command.SubcommandEntry>;

// Why: A type parameter of their own. The options are inferred as the selection they hold, which is
// all the actions' types read, so a list read from them would be lost whenever none is selected.
// A list typed as any commands names none, as options annotated `Options` hold it with or without
// a list: it adds nothing, where `unknown` would fail every program passing such options.
type OwnCommand<Own extends Subcommands> = Subcommands extends Own
  ? never
  : Own[number] extends infer Entry
    ? Entry extends Command.Command<infer _N, infer _I, infer _C, infer _E, infer _R>
      ? Entry
      : Entry extends Command.Command.SubcommandGroup<infer Commands>
        ? Commands[number]
        : never
    : never;

type CommandsOf<O> = O extends unknown
  ? "commands" extends keyof O
    ? NonNullable<O["commands" & keyof O]>
    : never
  : never;

type KeysOf<C> = C extends unknown ? keyof C : never;

type CommandOf<C, K> = C extends unknown ? (K extends keyof C ? C[K] : never) : never;

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

type Owning<App, A extends Action.Any> = App extends unknown
  ? A extends ActionOf<App>
    ? App
    : never
  : never;

type Local<App, A extends Action.Any> = Effect.Effect<
  A["success"]["Type"],
  A["error"][number]["Type"] | BuildError<App, A> | Action.BuiltIn,
  RequestOf<App, A> | BuildServices<App, A>
>;

const runWithBuildOfItsOwn = <App extends AnyImplementation, A extends Action.Any>(
  app: App,
  action: A,
  input: A["input"]["Type"],
): Local<App, A> => {
  const thisActionOnly = Implementation.share([action], app);

  const call = Effect.flatMap(acquire([thisActionOnly]), (bound) => {
    const [, run] = bound.find(([candidate]) => candidate === action) ?? [];

    return run === undefined ? Effect.die(new Error(`No handler for ${action.name}`)) : run(input);
  });

  const built = call.pipe(Effect.provide(Implementation.layerOf(thisActionOnly), { local: true }));

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased handler boundary: the builders' failures and services are the implementation's `EX` and `RX`, the handler's and authorization's services its entry of `R`; the handler fails with the action's errors or a `BuiltIn`, authorization with a refusal.
  return built as Local<App, A>;
};

const theImplementationOf = (
  apps: ReadonlyArray<AnyImplementation>,
  action: Action.Any,
): AnyImplementation => {
  const [app, ...others] = apps.filter((candidate) => candidate.actions.includes(action));

  if (app === undefined) throw new Error(`Action "${action.name}" has no implementation here`);

  if (others.length > 0) throw new Error(`Action "${action.name}" is implemented twice here`);

  return app;
};

const inProcess = <A extends Action.Any>(
  apps: ReadonlyArray<AnyImplementation>,
  action: A,
  options: CommandOptions<A> | undefined,
) => {
  const app = theImplementationOf(apps, action);

  return makeCommand(
    action,
    (input) => runWithBuildOfItsOwn(app, action, input),
    options,
    projectedErrors(action),
  );
};

const overHttp = <A extends Action.Any>(
  binding: AnyHttp,
  action: A,
  options: CommandOptions<A> | undefined,
  client: ClientOptions | undefined,
) => {
  if (!binding.actions.includes(action)) {
    throw new Error(`Action "${action.name}" is not in this HTTP binding`);
  }

  return makeCommand(
    action,
    (input) =>
      Effect.flatMap(httpClient(binding, client), (methods) => {
        const method = methods[action.name];

        if (method === undefined) throw new Error(`No client method for ${action.name}`);

        return method(input);
      }),
    options,
    bindingErrors(action, binding),
  );
};

const aggregateCommand = (
  name: string,
  actions: ReadonlyArray<Action.Any>,
  commands: NonNullable<Options["commands"]>,
  own: Subcommands,
  project: (
    action: Action.Any,
    options: CommandOptions<Action.Any> | undefined,
  ) => Command.Command<string, never, {}, unknown, unknown>,
) => {
  const derived = actions.map((action) => ({
    claimant: `action ${action.name}`,
    command: project(
      action,
      Object.hasOwn(commands, action.name) ? commands[action.name] : undefined,
    ),
  }));

  assertDistinct(
    "command",
    [
      ...derived.map(({ claimant, command }) => ({ claimant, name: command.name })),
      ...own
        .flatMap((entry) => (Command.isCommand(entry) ? [entry] : entry.commands))
        .map((command) => ({ claimant: "subcommands", name: command.name })),
    ],
    ({ name: claimed }) => claimed,
    ({ claimant }) => claimant,
  );

  // Why: One `withSubcommands`, as a second one replaces the first's commands.
  return Command.make(name).pipe(
    Command.withSubcommands([...derived.map(({ command }) => command), ...own]),
  );
};

const checkedCommandsOf = (
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
 * as JSON when it is not a struct. The flag of an array of strings or numbers is repeated for each value, a boolean
 * field is a switch, `--no-<name>` sending `false` as a required one left out does, and a field's `description` is its flag's help. It needs what the authorization, its handler and its builder
 * need; the host provides the identity. It prints the result on stdout; a failure is a
 * `UserError`, which `Command.run` prints on stderr. `remoteCommand` calls a server instead.
 */
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
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased implementation: the command runs `action` by its one implementation among `implementations`, so its channels are what `Local` states for that implementation.
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
   * `transformClient` for credentials. They reach this aggregate's requests alone. A URL or a
   * token read from `Config` goes instead into the `HttpClient` provided on the command, with
   * `Command.provideEffect(HttpClient.HttpClient, …)`: it is read when a command runs, so
   * `--help` needs neither, and a command of your own in `subcommands` calls through it too.
   * A required one that is not set fails that Effect with a `ConfigError`, which is no
   * command's failure and prints as a crash line: map the read,
   * `Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: "TOKEN is not set" }))`.
   */
  readonly client?: ClientOptions;
};

type HttpUserError<H extends AnyHttp, A extends Action.Any> = UserError<
  | A["error"][number]["Type"]
  | H["error"][number]["Type"]
  | VerifierError<A, H["authentication"]>["Type"]
  | Action.BuiltIn
  | HttpClientError.HttpClientError
  | Schema.SchemaError
>;

/**
 * Project every implemented action as a subcommand of one aggregate command, each named after
 * its action in kebab case and run in process. `commands` gives a subcommand the options
 * `command` takes, by action name; `subcommands` adds commands of your own, which
 * `Command.withSubcommands` on the result would put in the derived ones' place. `remote` calls a
 * server instead. A test runs it in memory, with no process:
 * `Command.runWith(command, { version })(args)`.
 * Guide: `docs/ActionCli.md` in this package; in an application: `examples/notes-service/src/commands.ts`.
 */
export function make<
  const Apps extends Served,
  const O extends Selection<ActionOf<Member<Apps>>> = {},
  const Own extends Subcommands = [],
>(
  implementations: Apps,
  options: O &
    NoInfer<Options<ActionOf<Member<Apps>>>> &
    NoInfer<KnownOptions<O, Options, ActionOf<Member<Apps>>>> & {
      readonly subcommands?: Own | undefined;
    },
): Command.Command<
  string,
  {},
  {},
  | UserError<Effect.Error<Local<Holding<Member<Apps>, SelectedOf<O, Apps>>, SelectedOf<O, Apps>>>>
  | Command.Error<OwnCommand<Own>>,
  | Effect.Services<Local<Holding<Member<Apps>, SelectedOf<O, Apps>>, SelectedOf<O, Apps>>>
  | Command.Services<OwnCommand<Own>>
> {
  const apps = toList(implementations);

  const commands = checkedCommandsOf(
    options.commands,
    apps.flatMap((app) => app.actions),
  );

  const served = select(apps, options.actions);

  const group = aggregateCommand(
    options.name,
    served.flatMap((app) => app.actions),
    commands,
    options.subcommands ?? [],
    (action, syntax) => inProcess(served, action, syntax),
  );

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dynamic subcommand list: each runs one action by its implementation, so the aggregate's channels are the unions of what `Local` states over them.
  return group as never;
}

/**
 * Project every action of an HTTP binding as a subcommand of one aggregate command, derived as
 * `make` derives it, each calling its action over HTTP. `client` configures every derived
 * subcommand's client; `commands` gives one the options `command` takes; `subcommands` adds
 * commands of your own.
 */
export function remote<
  const H extends AnyHttp,
  const O extends Selection<H["actions"][number]> = {},
  const Own extends Subcommands = [],
>(
  binding: H,
  options: O &
    NoInfer<RemoteOptions<H["actions"][number]>> &
    NoInfer<KnownOptions<O, RemoteOptions<Action.Any>, H["actions"][number]>> & {
      readonly subcommands?: Own | undefined;
    },
): Command.Command<
  string,
  {},
  {},
  HttpUserError<H, Selected<O, H["actions"][number]>> | Command.Error<OwnCommand<Own>>,
  HttpClient.HttpClient | Command.Services<OwnCommand<Own>>
> {
  const listed = options.actions;

  if (listed !== undefined) assertHeld("the binding does not hold it", listed, binding.actions);

  const commands = checkedCommandsOf(options.commands, binding.actions);

  const group = aggregateCommand(
    options.name,
    binding.actions.filter((action) => listed?.includes(action) ?? true),
    commands,
    options.subcommands ?? [],
    (action, syntax) => overHttp(binding, action, syntax, options.client),
  );

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dynamic subcommand list: each calls one action through the binding's client, so the aggregate's channels are the unions of what a client method states over them.
  return group as never;
}

// Why: Applied around the whole program, since `runMain`'s report of a defect or of a failed host
// layer runs outside every command and every layer the host provides. It moves the logger alone: a
// stderr `Console` around the program would move `--help` off stdout.
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

      const reportedDefectKeepingCause = Object.assign(new Error("Reported on stderr", { cause }), {
        [Runtime.errorReported]: false,
        [Runtime.errorExitCode]: Runtime.getErrorExitCode(squashed),
      });

      return Effect.andThen(
        Runtime.getErrorReported(squashed) ? Effect.logError(cause) : Effect.void,
        Effect.die(reportedDefectKeepingCause),
      );
    }),
    Effect.provideService(Logger.LogToStderr, true),
  );
