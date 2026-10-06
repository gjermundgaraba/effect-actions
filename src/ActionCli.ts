import { Cause, Effect, Logger, Predicate, Runtime, type Schema } from "effect";
import { Command } from "effect/cli";
import type { HttpClient, HttpClientError } from "effect/http";
import type * as Action from "./Action.js";
import { assertDistinct, assertKnown } from "./internal/actions.js";
import {
  type Failure,
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
  type BuildContext,
  type BuildError,
  assertHeld,
  type Holding,
  type Member,
  type RequestOf,
  select,
  type Known,
  type Selected,
  type Selection,
  type Served,
  toList,
} from "./internal/implementation.js";

/** How one command of `A` is named, takes its input and prints its result. */
export type { Options as CommandOptions } from "./internal/cli.js";

/**
 * What a command fails with when its action fails: Effect CLI's `UserError`, whose `cause`
 * and `reason` are the action's failure and whose message is its JSON, which `Command.run`
 * prints on stderr. A type only: after `Command.run`, match the reason by its tag,
 * `Effect.catchReason("UserError", "UserNotFound", f)`.
 */
export type { Failure } from "./internal/cli.js";

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
  RequestOf<App, A> | BuildContext<App, A>
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

    return run === undefined ? Effect.die(`No handler for ${action.name}`) : run(input);
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

/**
 * One command calling `action` through the binding's client, made with `client` on the
 * host's `HttpClient`, whose failures include the binding's errors.
 */
const remote = (
  http: AnyHttp,
  action: Action.Any,
  options: CommandOptions<Action.Any> | undefined,
  client: ClientOptions | undefined,
) => {
  assertInBinding(http.actions, action);

  return makeCommand(
    action,
    (input) => Effect.flatMap(methods(http, client), (methodOf) => methodOf(action)(input)),
    options,
    http.error,
  );
};

// A binding declares its native `api`; an implementation never does.
const isHttp = (value: AnyHttp | Served): value is AnyHttp => Predicate.hasProperty(value, "api");

/** Refuse client options for implementations, which run in process and connect nowhere. */
const assertClient = (target: AnyHttp | Served, client: ClientOptions | undefined): void => {
  if (client !== undefined && !isHttp(target)) {
    throw new Error("Client options are for a command over HTTP: pass a binding");
  }
};

/** `action`'s command: called over HTTP from a binding, or run by its one implementation. */
const project = (
  target: AnyHttp | Served,
  action: Action.Any,
  options: CommandOptions<Action.Any> | undefined,
  client: ClientOptions | undefined,
): Command.Command<string, never, {}, unknown, unknown> => {
  if (isHttp(target)) return remote(target, action, options, client);

  const app = implementationOf(toList(target), action);

  return makeCommand(action, (input) => local(app, action, input), options);
};

/**
 * Project one action into a native Effect CLI command, named after it in kebab case with one flag
 * per field of its input (`--user-id`), or `--input` taking the whole input as JSON when it is not
 * a struct. From an HTTP binding, the command calls the action over HTTP through its
 * `ActionHttp.client` method, made with the `client` options on the host's `HttpClient`, and fails
 * as the method does. From implementations, it runs the handler in process, behind its
 * implementation's authorization, and needs what the authorization, its handler and its builder
 * need; the host provides the identity. It prints the result on stdout; a failure is a
 * `Failure`, which `Command.run` prints on stderr.
 */
export function command<const H extends AnyHttp, A extends H["actions"][number]>(
  http: H,
  action: A,
  options?: CommandOptions<A> & {
    /**
     * Its client's options, as `ActionHttp.client` takes them: `baseUrl`, and
     * `transformClient` for credentials. They reach this command's requests alone.
     */
    readonly client?: ClientOptions;
  },
): Command.Command<
  string,
  never,
  {},
  Failure<
    | A["error"][number]["Type"]
    | H["error"][number]["Type"]
    | Action.BuiltIn
    | HttpClientError.HttpClientError
    | Schema.SchemaError
  >,
  HttpClient.HttpClient
>;
export function command<const Apps extends Served, A extends ActionOf<Member<Apps>>>(
  implementations: Apps,
  action: A,
  options?: CommandOptions<A>,
): Command.Command<
  string,
  never,
  {},
  Failure<Effect.Error<Local<Owning<Member<Apps>, A>, A>>>,
  Effect.Services<Local<Owning<Member<Apps>, A>, A>>
>;
// Last, and reached only when both forms above fail: TypeScript reports a call matching no
// overload by the last one's error alone, and this one's names the mistake in either form,
// such as a positional argument that is not a field. A target that is a binding or
// implementations, chosen by a condition, reaches it too, and owes `unknown`.
export function command<
  const T extends AnyHttp | Served,
  A extends (T extends AnyHttp ? T["actions"][number] : ActionOf<Member<T>>),
>(
  target: T,
  action: A,
  options?: CommandOptions<A> & (T extends AnyHttp ? { readonly client?: ClientOptions } : unknown),
): Command.Command<string, never, {}, unknown, unknown>;
export function command(
  target: AnyHttp | Served,
  action: Action.Any,
  options?: CommandOptions<Action.Any> & { readonly client?: ClientOptions },
): Command.Command<string, never, {}, unknown, unknown> {
  const { client, ...syntax } = options ?? {};

  assertClient(target, client);

  return project(target, action, options === undefined ? undefined : syntax, client);
}

/** An aggregate command's options over HTTP, its actions `A`. */
type HttpOptions<A extends Action.Any> = Options<A> & {
  /**
   * Every subcommand's client options, as `ActionHttp.client` takes them: `baseUrl`, and
   * `transformClient` for credentials. They reach this aggregate's requests alone.
   */
  readonly client?: ClientOptions;
};

/** What an aggregate command over binding `H` fails with, running its actions `A`. */
type HttpFailure<H extends AnyHttp, A extends Action.Any> = Failure<
  | A["error"][number]["Type"]
  | H["error"][number]["Type"]
  | Action.BuiltIn
  | HttpClientError.HttpClientError
  | Schema.SchemaError
>;

/**
 * Project every action as a subcommand of one aggregate command, each named after its
 * action in kebab case: each action of an HTTP binding called over HTTP, or each
 * implemented action run in process. `commands` gives a subcommand the options `command`
 * takes, by action name; over HTTP, `client` configures every subcommand's client.
 */
// Without `actions`, every action is a command; options whose `actions` may be absent may run
// every action, so they type every command. `commands` is typed by every action of the
// target, so one record serves aggregates of different selections: a command of an action
// left out is unused.
export function make<const H extends AnyHttp, const O extends Selection<H["actions"][number]> = {}>(
  http: H,
  options: O &
    NoInfer<HttpOptions<H["actions"][number]>> &
    NoInfer<KnownOptions<O, HttpOptions<Action.Any>, H["actions"][number]>>,
): Command.Command<
  string,
  {},
  {},
  HttpFailure<H, Selected<O, H["actions"][number]>>,
  HttpClient.HttpClient
>;
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
  Failure<
    Effect.Error<
      Local<
        Holding<Member<Apps>, Selected<O, ActionOf<Member<Apps>>>>,
        Selected<O, ActionOf<Member<Apps>>>
      >
    >
  >,
  Effect.Services<
    Local<
      Holding<Member<Apps>, Selected<O, ActionOf<Member<Apps>>>>,
      Selected<O, ActionOf<Member<Apps>>>
    >
  >
>;
// Last, and reached only when the forms above fail: TypeScript reports a call matching no
// overload by the last one's error alone, and this one's names every option mistake in
// either form, such as a misspelled `commands` key. A target that is a binding or
// implementations, chosen by a condition, reaches it too, and owes `unknown`.
export function make<const T extends AnyHttp | Served>(
  target: T,
  options: NoInfer<
    Options<T extends AnyHttp ? T["actions"][number] : ActionOf<Member<T>>> &
      (T extends AnyHttp ? { readonly client?: ClientOptions } : unknown)
  >,
): Command.Command<string, {}, {}, unknown, unknown>;
export function make(
  target: AnyHttp | Served,
  options: Options & { readonly client?: ClientOptions },
): Command.Command<string, {}, {}, unknown, unknown> {
  const commands = options.commands ?? {};

  assertClient(target, options.client);

  // The listed actions only, each projected as before: a binding's, or those an
  // implementation holds, sharing its builder and authorization.
  const listed = options.actions;

  if (isHttp(target) && listed !== undefined) {
    assertHeld("the binding does not hold it", listed, target.actions);
  }

  // A command of any action of the target, so one record serves several selections.
  assertKnown(
    "commands",
    Object.keys(commands),
    (isHttp(target) ? target.actions : toList(target).flatMap((app) => app.actions)).map(
      (action) => action.name,
    ),
  );

  const served = isHttp(target) ? target : select(toList(target), listed);

  const actions = isHttp(served)
    ? served.actions.filter((action) => listed?.includes(action) ?? true)
    : toList(served).flatMap((app) => app.actions);

  const subcommands = actions.map((action) => ({
    action,
    command: project(
      served,
      action,
      Object.hasOwn(commands, action.name) ? commands[action.name] : undefined,
      options.client,
    ),
  }));

  // An action served twice has one name twice, so this refuses it too.
  assertDistinct(
    "command",
    subcommands,
    ({ command }) => command.name,
    ({ action }) => `action ${action.name}`,
  );

  const group = Command.make(options.name).pipe(
    Command.withSubcommands(subcommands.map(({ command }) => command)),
  );

  // SAFETY: every subcommand runs or calls one action, so the aggregate's channels are
  // the unions of what `Local` and a client method state over them.
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
export const onStderr = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, never, R> =>
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
