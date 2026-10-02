import { Effect, Predicate, type Schema } from "effect";
import { Command } from "effect/cli";
import type { HttpClient, HttpClientError } from "effect/http";
import type * as Action from "./Action.js";
import { assertDistinct, assertKnown } from "./internal/actions.js";
import {
  type Failure,
  command as makeCommand,
  type Options as CommandOptions,
} from "./internal/cli.js";
import { type AnyHttp, assertInBinding, methods } from "./internal/client.js";
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

/**
 * What a command fails with when its action fails: Effect CLI's `UserError`, whose `cause`
 * is the action's failure and whose message is its JSON, which `Command.run` prints on
 * stderr. A type only: after `Command.run`, match the cause, `error.cause instanceof X`.
 */
export type { Failure } from "./internal/cli.js";

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
 * What one local command of `A` runs: its implementation's builder and hook, then its
 * handler. Any hook may refuse and any handler fail with a built-in error, so every one
 * fails with `Action.BuiltIn` too.
 */
type Local<App, A extends Action.Any> = Effect.Effect<
  A["success"]["Type"],
  A["errors"][number]["Type"] | BuildError<App> | Action.BuiltIn,
  RequestOf<App, A> | BuildContext<App>
>;

/**
 * Build the implementation's handlers for this call alone, run one action through its hook
 * and its handler, and release them: every local command, selected or aggregated. The call's
 * own scope, which every call has, closes first, so its finalizers run while the builder's
 * resources are still open; a local build never reuses one the host already made.
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

  const built = call.pipe(Effect.provide(Implementation.layerOf(app), { local: true }));

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

/**
 * One command calling `action` through the binding's client, on the host's `HttpClient`,
 * whose failures include the binding's errors.
 */
const remote = (
  http: AnyHttp,
  action: Action.Any,
  options: CommandOptions<Action.Any> | undefined,
) => {
  assertInBinding(http.actions, action);

  return makeCommand(
    action,
    (input) => Effect.flatMap(methods(http), (methodOf) => methodOf(action)(input)),
    options,
    http.errors,
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
 * HTTP through its `ActionHttp.client` method, on the host's `HttpClient`, and fails as the
 * method does. From implementations, it runs the handler in process, behind its
 * implementation's `before` hook, and needs what its handler, hook and builder need; the
 * host provides the identity. It prints the result on stdout; a failure is a `Failure`,
 * which `Command.run` prints on stderr.
 */
export function command<const H extends AnyHttp, A extends H["actions"][number]>(
  http: H,
  action: A,
  options?: CommandOptions<A>,
): Command.Command<
  string,
  never,
  {},
  Failure<
    | A["errors"][number]["Type"]
    | H["errors"][number]["Type"]
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
  Failure<Effect.Error<Local<Selected<Member<Apps>, A>, A>>>,
  Effect.Services<Local<Selected<Member<Apps>, A>, A>>
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
  options?: CommandOptions<A>,
): Command.Command<string, never, {}, unknown, unknown>;
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
export function make<const H extends AnyHttp>(
  http: H,
  options: NoInfer<Options<H["actions"][number]>>,
): Command.Command<
  string,
  {},
  {},
  Failure<
    | H["actions"][number]["errors"][number]["Type"]
    | H["errors"][number]["Type"]
    | Action.BuiltIn
    | HttpClientError.HttpClientError
    | Schema.SchemaError
  >,
  HttpClient.HttpClient
>;
export function make<const Apps extends Served>(
  implementations: Apps,
  options: NoInfer<Options<ActionOf<Member<Apps>>>>,
): Command.Command<
  string,
  {},
  {},
  Failure<Effect.Error<Local<Member<Apps>, ActionOf<Member<Apps>>>>>,
  Effect.Services<Local<Member<Apps>, ActionOf<Member<Apps>>>>
>;
// Last, and reached only when both forms above fail: TypeScript reports a call matching no
// overload by the last one's error alone, and this one's names every option mistake in
// either form, such as a misspelled `commands` key. A target that is a binding or
// implementations, chosen by a condition, reaches it too, and owes `unknown`.
export function make<const T extends AnyHttp | Served>(
  target: T,
  options: NoInfer<Options<T extends AnyHttp ? T["actions"][number] : ActionOf<Member<T>>>>,
): Command.Command<string, {}, {}, unknown, unknown>;
export function make(
  target: AnyHttp | Served,
  options: Options,
): Command.Command<string, {}, {}, unknown, unknown> {
  const commands = options.commands ?? {};

  const actions = isHttp(target) ? target.actions : toList(target).flatMap((app) => app.actions);

  assertKnown(
    "commands",
    Object.keys(commands),
    actions.map((action) => action.name),
  );

  const subcommands = actions.map((action) => ({
    action,
    command: project(
      target,
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

  const group = Command.make(options.name).pipe(
    Command.withSubcommands(subcommands.map(({ command }) => command)),
  );

  // SAFETY: every subcommand runs or calls one action, so the aggregate's channels are
  // the unions of what `Local` and a client method state over them.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dynamic subcommand list.
  return group as never;
}
