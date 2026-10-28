import { Cause, Effect, Logger, Runtime, Stream } from "effect";
import { Command } from "effect/cli";
import type { CliError } from "effect/cli";
import type { HttpClient } from "effect/http";

import * as Action from "../contract/Action.js";
import {
  projectedErrors,
  bindingErrors,
  eventErrors,
} from "../contract/declared.js";
import type { Declaring } from "../contract/declared.js";
import type * as Event from "../contract/Event.js";
import type {
  EventBuildError,
  EventBuildServices,
  EventOf,
  EventRequestOf,
  ServingEvents,
} from "../contract/feed.js";
import {
  acquire,
  Implementation,
  assertHeld,
  notHeld,
  toList,
  elementsOf,
} from "../contract/implementation.js";
import type {
  ActionOf,
  AnyImplementation,
  BuildServices,
  BuildError,
  Holding,
  Member,
  RequestOf,
  Known,
  Selected,
  SelectedEvents,
  SelectedEventsOf,
  SelectedOf,
  Selection,
  Served,
  ServedActions,
} from "../contract/implementation.js";
import { selection } from "../contract/listed.js";
import { assertDistinct, assertKnown } from "../contract/names.js";
import { progressSink } from "../contract/progress.js";
import type { CallOptions } from "../contract/progress.js";
import type { Receiving } from "../contract/receiving.js";
import { selectFrom } from "../contract/serving.js";
import { elementOf } from "../contract/stream.js";
import type { WatchArgs } from "../contract/watch.js";
import { client as httpClient } from "../http/ActionHttp.js";
import type { Any as AnyHttp, Client, WatchError } from "../http/ActionHttp.js";
import {
  command as makeCommand,
  failingAsDerived,
  watchCommand,
} from "./commands.js";
import type { UserError, Options as CommandOptions } from "./commands.js";

export type { Options as CommandOptions } from "./commands.js";

export type { UserError } from "./commands.js";

interface AnyBinding extends Declaring {
  readonly actions: readonly Action.Any[];
}

/**
 * Make a command of your own fail as a derived command does. Give it what the command calls, the
 * binding of `ActionHttp.client` or `ActionRpc.client`, or the actions of `Action.client`, and
 * pipe the command's whole Effect through it: a failure that is a declared error, the binding's
 * and its authentication's included, or a built-in one becomes a `UserError` whose message is its
 * JSON, and any other, a transport failure for one, a `UserError` naming it and the causes
 * beneath it. An Effect CLI error, your own `new CliError.UserError({ cause, userMessage })`
 * included, passes through as it is.
 *
 * **Gotchas**
 *
 * - A failure left unmapped, one call's included, is reported as a crash, `ERROR (#n)` with a stack trace: pipe the whole Effect through it, once.
 * - To add context, such as how far a batch got, print it before this in the pipe, `Effect.tapError(() => Console.error(…))`: a `UserError` wrapped around the result puts its JSON mid-sentence and hides the action's failure from `catchReason`.
 */
export const toUserError = (calls: AnyBinding | readonly Action.Any[]) =>
  "actions" in calls
    ? failingAsDerived(
        calls.actions.flatMap((action) => bindingErrors(action, calls))
      )
    : failingAsDerived(calls.flatMap((action) => projectedErrors(action)));

/**
 * An aggregate command of the actions `A`: its name, the actions that are its subcommands,
 * and their options.
 */
export interface Options<
  A extends Action.Any | Event.Any = Action.Any | Event.Any,
> {
  /** The aggregate command's name. */
  readonly name: string;
  /**
   * The actions that are subcommands and the event types that have a `watch`, among the
   * binding's or the implementations': `[GetUser, RenameUser, UserRenamed]`, exactly those.
   * Defaults to every one of them.
   *
   * **Gotchas**
   *
   * - A list naming actions alone adds no `watch`: list the event types beside them.
   */
  readonly actions?: readonly A[] | undefined;
  /**
   * The options of each subcommand, keyed by its action's name, as `command` takes them:
   * `{ readFile: { positional: ["path"], render } }`.
   */
  readonly commands?: {
    readonly [K in Extract<A, Action.Any> as K["name"]]?: CommandOptions<K>;
  };
  /**
   * Commands of your own beside the derived ones, as `Command.withSubcommands` takes them:
   * `[importLinks]`, each made with Effect CLI's `Command.make` and printing its output itself,
   * with `Console.log`. One calls actions through a client in its own handler: `yield*` the
   * Effect `remote` takes as `client`, which needs no scope, or `Action.client`, acquired inside
   * `Effect.scoped`. It fails as you make it fail: through `toUserError` as a derived command
   * does, or with a `CliError.UserError` for `Command.run` to print its `userMessage` on stderr.
   *
   * **Gotchas**
   *
   * - Write the list in the call, or hold the options with `satisfies ActionCli.Options<…>`: in options annotated `: ActionCli.Options<…>` it adds none of its commands' failures and services to the aggregate's type, so the program compiles, then a command's service is not found.
   * - Never pipe `Command.withSubcommands` onto the aggregate instead: it replaces the derived commands, which then answer with the usage text.
   */
  readonly subcommands?: Subcommands | undefined;
}

type Subcommands = readonly Command.Command.SubcommandEntry[];

type OwnCommand<Own extends Subcommands> = Subcommands extends Own
  ? never
  : Own[number] extends infer Entry
    ? Entry extends Command.Command<
        infer _N,
        infer _I,
        infer _C,
        infer _E,
        infer _R
      >
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

type CommandOf<C, K> = C extends unknown
  ? K extends keyof C
    ? C[K]
    : never
  : never;

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

const runWithBuildOfItsOwn = <
  App extends AnyImplementation,
  A extends Action.Any,
>(
  app: App,
  action: A,
  input: A["input"]["Type"],
  onProgress: CallOptions<unknown>["onProgress"]
): Local<App, A> => {
  const thisActionOnly = Implementation.share([action], app);

  const call = Effect.flatMap(acquire([thisActionOnly], undefined), (bound) => {
    const [, run] = bound.find(([candidate]) => candidate === action) ?? [];

    return run === undefined
      ? Effect.die(new Error(`No handler for ${action.name}`))
      : run(input, progressSink(onProgress));
  });

  const builder = Implementation.layerOf(thisActionOnly);

  const buildScopedToAnswer =
    elementOf(action.success) === undefined
      ? call.pipe(Effect.provide(builder, { local: true }))
      : Effect.succeed(
          elementsOf(call).pipe(Stream.provide(builder, { local: true }))
        );

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return buildScopedToAnswer as Local<App, A>;
};

const theImplementationOf = (
  apps: readonly AnyImplementation[],
  action: Action.Any
): AnyImplementation => {
  const [app, ...others] = apps.filter((candidate) =>
    candidate.actions.includes(action)
  );

  if (app === undefined) {
    throw new Error(
      `Action "${action.name}" has no implementation here (pass its implementation, and select with the contract value it implements: an equal-looking action does not match)`
    );
  }

  if (others.length > 0) {
    throw new Error(
      `Action "${action.name}" is implemented twice here (pass one of them)`
    );
  }

  return app;
};

const inProcess = <A extends Action.Any>(
  apps: readonly AnyImplementation[],
  action: A,
  options: CommandOptions<A> | undefined
) => {
  const app = theImplementationOf(apps, action);

  return makeCommand(
    action,
    (input, onProgress) => runWithBuildOfItsOwn(app, action, input, onProgress),
    options,
    projectedErrors(action)
  );
};

const overHttp = <A extends Action.Any>(
  binding: AnyHttp,
  action: A,
  options: CommandOptions<A> | undefined,
  client: ErasedClient | undefined
) => {
  if (!binding.actions.includes(action)) {
    throw new Error(
      `Action "${action.name}" is not in this HTTP binding (pass it to the binding's ActionHttp.make, and select with the contract value it received)`
    );
  }

  return makeCommand(
    action,
    (input, onProgress) =>
      Effect.flatMap(client ?? httpClient(binding), (methods) => {
        const method = methods[action.name];

        if (method === undefined) {
          throw new Error(
            `No client method for ${action.name} (give \`client\` a method for this action)`
          );
        }

        const answer = method(input, { onProgress });

        return Stream.isStream(answer) ? Effect.succeed(answer) : answer;
      }),
    options,
    bindingErrors(action, binding)
  );
};

type LocalCall<Apps extends Served, O> = [SelectedOf<O, Apps>] extends [never]
  ? never
  : Local<Holding<Member<Apps>, SelectedOf<O, Apps>>, SelectedOf<O, Apps>>;

type LocalWatch<App, Listed extends Event.Any> = [
  ServingEvents<App, Listed>,
] extends [never]
  ? never
  : Effect.Effect<
      void,
      Event.SubscriptionError | Action.BuiltIn | EventBuildError<App, Listed>,
      | EventRequestOf<App, ServingEvents<App, Listed>>
      | EventBuildServices<App, Listed>
    >;

type Watched<M, E extends Event.Any> = M extends {
  readonly watch: (
    event: E,
    ...args: WatchArgs<E, never>
  ) => Stream.Stream<unknown, infer WE, infer WR>;
}
  ? { readonly error: WE; readonly services: Exclude<WR, Receiving> }
  : { readonly error: never; readonly services: never };

type WatchFailure<H extends AnyHttp, C, E extends Event.Any> = [E] extends [
  never,
]
  ? never
  : C extends Effect.Effect<infer M, infer CE, unknown>
    ? CE | Watched<M, E>["error"]
    : WatchError<E, H>;

type WatchServices<C, E extends Event.Any> = [E] extends [never]
  ? never
  : C extends Effect.Effect<infer M, unknown, infer CR>
    ? CR | Watched<M, E>["services"]
    : HttpClient.HttpClient;

const watched = (
  event: Event.Any,
  client: Effect.Effect<
    Pick<Client<AnyHttp, unknown, unknown>, "watch">,
    unknown,
    unknown
  >,
  errors: Action.Errors
) =>
  watchCommand(
    event,
    (input, cursor) =>
      Stream.unwrap(
        Effect.map(client, (methods) => methods.watch(event, input, { cursor }))
      ),
    errors
  );

const aggregateCommand = (
  name: string,
  actions: readonly Action.Any[],
  commands: NonNullable<Options["commands"]>,
  own: Subcommands,
  project: (
    action: Action.Any,
    options: CommandOptions<Action.Any> | undefined
  ) => Command.Command<string, never, {}, unknown, unknown>,
  watches: ReadonlyArray<Command.Command<string, never, {}, unknown, unknown>>
) => {
  const derived = [
    ...actions.map((action) => ({
      claimant: `action ${action.name}`,
      command: project(
        action,
        Object.hasOwn(commands, action.name) ? commands[action.name] : undefined
      ),
    })),
    ...(watches.length === 0
      ? []
      : [
          {
            claimant: "the event types",
            command: Command.make("watch").pipe(
              Command.withDescription(
                "Watch an event type, each occurrence a line of JSON"
              ),
              Command.withSubcommands(watches)
            ),
          },
        ]),
  ];

  assertDistinct(
    "command",
    [
      ...derived.map(({ claimant, command: derivedCommand }) => ({
        claimant,
        name: derivedCommand.name,
      })),
      ...own
        .flatMap((entry) =>
          Command.isCommand(entry) ? [entry] : entry.commands
        )
        .map((subcommand) => ({
          claimant: "subcommands",
          name: subcommand.name,
        })),
    ],
    ({ name: claimed }) => claimed,
    {
      claimantOf: ({ claimant }) => claimant,
      fix: "rename one of your subcommands, or give an action's command another name in commands",
    }
  );

  return Command.make(name).pipe(
    Command.withSubcommands([
      ...derived.map(({ command: derivedCommand }) => derivedCommand),
      ...own,
    ])
  );
};

const checkedCommandsOf = (
  commands: Options["commands"],
  actions: readonly Action.Any[]
): NonNullable<Options["commands"]> => {
  const given = commands ?? {};

  assertKnown(
    "commands",
    Object.keys(given),
    actions.map((action) => action.name),
    "key it by the action's own name, not its command's"
  );

  return given;
};

/**
 * Project one implemented action into a native Effect CLI command that runs its handler in
 * process, behind its implementation's authorization. It is named after the action in kebab
 * case, with one flag per top-level field of its input (`--user-id`), or `--input` taking the
 * whole input as JSON when it is not a struct of named fields. The host provides the caller on
 * the command, `Command.provideSync`, beside what the authorization, the handler and the builder
 * need. `remoteCommand` calls a server instead.
 *
 * **Gotchas**
 *
 * - A success is its JSON on stdout, indented by two spaces, or `render`'s text; nothing for an action without `success`. Its Effect logs and `Console` output go to stderr; other writes as `logToStderr` says.
 * - Each value an action declaring `progress` reports is one line of compact JSON on stderr, as it arrives, so stdout holds the answer alone; `remoteCommand` asks the server for them too.
 * - An action answering a stream prints each element on stdout as it arrives, one line of compact JSON, or `render`'s text of it; a declared failure ends the command after the elements before it.
 * - A declared error is its JSON on stderr, under Effect CLI's `ERROR` heading, the command failing with a `UserError` whose `cause` is the error, exit 1 or its `Runtime.errorExitCode`; a refusal as `Action.Unauthenticated` and `Action.Forbidden` say; input that does not decode, in `--input` or a flag's JSON value, is `InvalidInput`'s JSON there, while a missing flag or a rejected choice is Effect CLI's own parse error.
 * - Effect CLI styles what it prints, a failure's JSON included, on a terminal and, from Effect 4.0.6, wherever `FORCE_COLOR` forces colour: for plain text there, set `NO_COLOR` or provide `TerminalCapabilities.TerminalCapabilities` with `canColor: false`.
 * - A failure no schema encodes, a builder's or an accepted error that does not encode, is a `UserError` printed as its tag or name and its message, then its causes, never its other fields; a defect, an undeclared failure, or a success that does not encode is the command's defect, which `runMain` reports as `logToStderr` says.
 * - Provide services with `Command.provide` on the command, built when an action runs: provided around `Command.run`, they are built before parsing, so `--help` and a mistyped flag open the database.
 * - Each run builds the action's implementation, its builder and an authorizer an Effect builds, and releases them after the call, even where the host already built them; implementations passed beside it are not built.
 * - A field named like a global flag (`help`, `version`, `log-level`) is no clash: its flag shadows the global one on this command.
 */
export const command = <
  const Apps extends ServedActions,
  A extends ActionOf<Member<Apps>>,
  const O = {},
>(
  implementations: Apps,
  action: A,
  options?: O &
    NoInfer<CommandOptions<A>> &
    NoInfer<Known<O, CommandOptions<Action.Any>>>
): Command.Command<
  string,
  never,
  {},
  Failing<Effect.Error<Local<Owning<Member<Apps>, A>, A>>>,
  Effect.Services<Local<Owning<Member<Apps>, A>, A>>
> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  inProcess(toList(implementations), action, options) as never;

/**
 * Project one action of an HTTP binding into a native Effect CLI command, derived as `command`
 * derives it, that calls the action through `client`'s method and fails as the method does, or
 * as the Effect building the client does. It runs nothing locally and names no caller: the
 * server verifies the credentials its client sends.
 */
export function remoteCommand<
  const H extends AnyHttp,
  A extends H["actions"][number],
  const O = {},
  C extends ClientOf<H, A> | undefined = undefined,
>(
  binding: H,
  action: A,
  options?: O &
    NoInfer<CommandOptions<A>> &
    NoInfer<Known<O, RemoteKeys<CommandOptions<Action.Any>>>> &
    Calling<C>
): Command.Command<
  string,
  never,
  {},
  Failing<CallFailure<H, C, A>>,
  CallServices<C, A>
>;
export function remoteCommand(
  binding: AnyHttp,
  action: Action.Any,
  options?: CommandOptions<Action.Any> & Calling<ErasedClient>
): Command.Command<string, never, {}, unknown, unknown> {
  const { client, ...syntax } = options ?? {};

  return overHttp(
    binding,
    action,
    options === undefined ? undefined : syntax,
    client
  );
}

/** The `client` option of `remote` and `remoteCommand`, declared once for both. */
export interface Calling<C> {
  /**
   * The connection: an Effect of the binding's client, such as
   * `ActionHttp.client(Http, { baseUrl, transformClient })`, run each time a command runs, so one
   * reading `Config` is an `Effect.gen` returning `yield* ActionHttp.client(…)` and `--help`
   * reads nothing. What it requires, the host provides. Omitted, it is
   * `ActionHttp.client(binding)` on the host's `HttpClient`, with no `baseUrl`. It needs only the
   * methods of the actions it derives commands for: those `remote`'s `actions` lists, or
   * `remoteCommand`'s one.
   *
   * **Gotchas**
   *
   * - A token read with `Config` and not set fails every command, a public one's too, as `ConfigError: …`, which names no fix: map it to a tagged error whose `message` says what to do, or read an optional one with `Config.option`.
   * - Credentials go in `transformClient`: a command adds no headers of its own, so without them a protected action answers `Unauthenticated`.
   * - Never transform the `HttpClient` around the program instead: it rewrites every request the program makes, an absolute URL too, and sends each one the token.
   */
  readonly client?: C;
}

type ClientOf<
  H extends AnyHttp,
  A extends Action.Any,
  E extends Event.Any = never,
> = Effect.Effect<
  Pick<
    Client<H, unknown, unknown>,
    A["name"] | ([E] extends [never] ? never : "watch")
  >,
  unknown,
  unknown
>;

type ErasedClient = Effect.Effect<
  Client<AnyHttp, unknown, unknown>,
  unknown,
  unknown
>;

type Needed<
  O,
  L extends readonly unknown[],
  All extends Action.Any,
> = "actions" extends (O extends unknown ? keyof O : never)
  ? Selected<O, All>
  : Extract<L[number], All>;

type NeededEvents<
  O,
  L extends readonly unknown[],
  All extends Event.Any,
> = "actions" extends (O extends unknown ? keyof O : never)
  ? SelectedEvents<O, All>
  : Extract<L[number], All>;

type RemoteKeys<Keys> = Keys & { readonly client?: unknown };

type Failing<F> = [F] extends [never]
  ? never
  : UserError<Exclude<F, CliError.CliError>> | Extract<F, CliError.CliError>;

type Called<M, A extends Action.Any> = A extends unknown
  ? A["name"] extends keyof M
    ? M[A["name"]] extends (...input: never) => infer Call
      ? Call
      : never
    : never
  : never;

type CallError<Call> = Effect.Error<Call> | Stream.Error<Call>;

type CallRequirements<Call> = Effect.Services<Call> | Stream.Services<Call>;

type CallFailure<H extends AnyHttp, C, A extends Action.Any> =
  C extends Effect.Effect<infer M, infer CE, unknown>
    ? CE | CallError<Called<M, A>>
    : CallError<Called<Client<H>, A>>;

type CallServices<C, A extends Action.Any> =
  C extends Effect.Effect<infer M, unknown, infer CR>
    ? CR | CallRequirements<Called<M, A>>
    : HttpClient.HttpClient;

/**
 * Project the implemented actions, every one or those `actions` selects, as subcommands of one
 * aggregate command, each derived as `command` derives it and run in process. `commands` gives a
 * subcommand the options `command` takes, by action name; `subcommands` adds commands of your
 * own. `remote` calls a server instead. Each event type among the implementations, or each
 * `actions` lists, adds `watch <event>`, a flag per input field and `--cursor`, printing each
 * occurrence, or a `Gap`, as one line of JSON, its `cursor` included, until it is stopped. A test
 * runs it in memory, with no process: `Command.runWith(command, { version })(args)`.
 * Guide: `docs/ActionCli.md` in this package; in an application: `examples/assistant/src/commands.ts`.
 *
 * **Gotchas**
 *
 * - Services provided on it with `Command.provide` are also built when it runs with no subcommand, before it shows its help.
 * - An event input field named `cursor` throws when `make` or `remote` is called, `--cursor` claiming its flag: rename the field.
 * - A watch's refusal, when it starts or later, or `Event.SubscriptionError`, ends the command as its `UserError`, exit 1, after the lines it printed.
 */
export const make = <
  const Apps extends Served,
  const O extends Selection<ActionOf<Member<Apps>> | EventOf<Member<Apps>>> =
    {},
  const Own extends Subcommands = [],
>(
  implementations: Apps,
  options: O &
    NoInfer<Options<ActionOf<Member<Apps>> | EventOf<Member<Apps>>>> &
    NoInfer<KnownOptions<O, Options, ActionOf<Member<Apps>>>> & {
      readonly subcommands?: Own | undefined;
    }
): Command.Command<
  string,
  {},
  {},
  | Failing<
      Effect.Error<
        LocalCall<Apps, O> | LocalWatch<Member<Apps>, SelectedEventsOf<O, Apps>>
      >
    >
  | Command.Error<OwnCommand<Own>>,
  | Effect.Services<
      LocalCall<Apps, O> | LocalWatch<Member<Apps>, SelectedEventsOf<O, Apps>>
    >
  | Command.Services<OwnCommand<Own>>
> => {
  const apps = toList(implementations);
  const { apps: served, events } = selectFrom(implementations, options.actions);

  const commands = checkedCommandsOf(
    options.commands,
    apps.flatMap((app) => app.actions)
  );

  const group = aggregateCommand(
    options.name,
    served.flatMap((app) => app.actions),
    commands,
    options.subcommands ?? [],
    (action, syntax) => inProcess(served, action, syntax),
    events.flatMap((app) =>
      app.events.map((event) =>
        watched(event, Action.client(app), eventErrors(event, { error: [] }))
      )
    )
  );

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return group as never;
};

/**
 * Project the actions of an HTTP binding, every one or those `actions` selects, as subcommands of
 * one aggregate command, derived as `make` derives them, each calling its action through
 * `client`'s method, as `remoteCommand` does. `commands` gives one the options `command` takes;
 * `subcommands` adds commands of your own, which call through the same client by yielding the
 * Effect given as `client`. Each event type of the binding, or each `actions` lists, adds
 * `watch <event>`, as `make` adds it, watching through `client`'s `watch`, which reconnects as
 * `ActionHttp.client`'s does.
 * In an application: `examples/notes-service/src/commands.ts`, and for events,
 * `examples/build-events/src/commands.ts`.
 */
export function remote<
  const H extends AnyHttp,
  const O extends Selection<H["actions"][number] | H["events"][number]> = {},
  const Own extends Subcommands = [],
  const L extends ReadonlyArray<H["actions"][number] | H["events"][number]> = [
    ...H["actions"],
    ...H["events"],
  ],
  C extends
    | ClientOf<
        H,
        Needed<O, L, H["actions"][number]>,
        NeededEvents<O, L, H["events"][number]>
      >
    | undefined = undefined,
>(
  binding: H,
  options: O &
    NoInfer<Options<H["actions"][number] | H["events"][number]>> &
    NoInfer<KnownOptions<O, RemoteKeys<Options>, H["actions"][number]>> &
    Calling<C> & {
      readonly actions?: L | undefined;
      readonly subcommands?: Own | undefined;
    }
): Command.Command<
  string,
  {},
  {},
  | Failing<
      | CallFailure<H, C, Selected<O, H["actions"][number]>>
      | WatchFailure<H, C, SelectedEvents<O, H["events"][number]>>
    >
  | Command.Error<OwnCommand<Own>>,
  | CallServices<C, Selected<O, H["actions"][number]>>
  | WatchServices<C, SelectedEvents<O, H["events"][number]>>
  | Command.Services<OwnCommand<Own>>
>;
export function remote(
  binding: AnyHttp,
  options: Options & { readonly client?: ErasedClient | undefined }
): Command.Command<string, {}, {}, unknown, unknown> {
  const listed = selection(options.actions);

  if (listed.actions !== undefined) {
    assertHeld(notHeld.byBinding, listed.actions, binding.actions);
  }

  if (listed.events !== undefined) {
    assertHeld(notHeld.byBinding, listed.events, binding.events);
  }

  const commands = checkedCommandsOf(options.commands, binding.actions);

  const group = aggregateCommand(
    options.name,
    binding.actions.filter(
      (action) => listed.actions?.includes(action) ?? true
    ),
    commands,
    options.subcommands ?? [],
    (action, syntax) => overHttp(binding, action, syntax, options.client),
    binding.events
      .filter((event) => listed.events?.includes(event) ?? true)
      .map((event) =>
        watched(
          event,
          options.client ?? httpClient(binding),
          eventErrors(event, binding)
        )
      )
  );

  return group;
}

/**
 * A program whose stdout carries only its results, such as a CLI feeding scripts or an MCP
 * subprocess, applied last, before `NodeRuntime.runMain`: the default logger of every layer
 * provided within writes to stderr, and a failure `runMain` would report on stdout, such as a
 * defect, a success that does not encode or a failure of a layer the host provides, is reported
 * on stderr instead, once. A command's own failure, which `Command.run` has printed, is not
 * reported again. The exit code is the one `runMain` gives: the failure's
 * `Runtime.errorExitCode`, 1 by default, or 130 for an interruption.
 *
 * **Gotchas**
 *
 * - It moves the default logger only: a host layer's `Console` output, the global `console.log`, and a logger writing through `Console.log` such as `Logger.consoleJson`, still reach stdout; log JSON with `Logger.withConsoleError(Logger.formatJson)`.
 */
export const logToStderr = <A, E, R>(
  self: Effect.Effect<A, E, R>
): Effect.Effect<A, never, R> =>
  self.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.interrupt;
      }

      const squashed = Cause.squash(cause);

      const reportedDefectKeepingCause = Object.assign(
        new Error("Reported on stderr", { cause }),
        {
          [Runtime.errorReported]: false,
          [Runtime.errorExitCode]: Runtime.getErrorExitCode(squashed),
        }
      );

      return Effect.andThen(
        Runtime.getErrorReported(squashed)
          ? Effect.logError(cause)
          : Effect.void,
        Effect.die(reportedDefectKeepingCause)
      );
    }),
    Effect.provideService(Logger.LogToStderr, true)
  );
