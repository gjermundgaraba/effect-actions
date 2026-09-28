import { Effect, Predicate, type Schema, type Scope } from "effect";
import { Command } from "effect/unstable/cli";
import type { HttpClient } from "effect/unstable/http";
import type * as Action from "./Action.js";
import { assertDistinct } from "./internal/actions.js";
import { kebab, command as makeCommand, type Options as CommandOptions } from "./internal/cli.js";
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
  type Member,
  type RequestOf,
  type Served,
  toList,
} from "./internal/implementation.js";

/**
 * How a command is named and prints its result. A command over HTTP also takes the
 * client's options, `ActionHttp.ClientOptions`.
 */
export type { Options } from "./internal/cli.js";

/**
 * The name of an aggregate command. One over HTTP also takes the client's options,
 * `ActionHttp.ClientOptions`.
 */
export interface MakeOptions {
  /** The aggregate command's name. */
  readonly name: string;
}

/** Every option, erased: the public signatures restore them. */
type ErasedOptions = CommandOptions<Action.Any> & ClientOptions;

/** The implementation of `A` among `App`. */
type Selected<App, A extends Action.Any> = App extends unknown
  ? A extends ActionOf<App>
    ? App
    : never
  : never;

/**
 * What one local command of `A` runs: its implementation's hook, then its handler. A CLI
 * serializes no failure, so a refusal is a typed failure of the command effect.
 */
type Local<App, A extends Action.Any> = Effect.Effect<
  A["success"]["Type"],
  A["errors"][number]["Type"] | BuildError<App> | Action.Refusal,
  Exclude<RequestOf<App, A> | BuildContext<App>, Scope.Scope>
>;

/** A native command running `Local`, or subcommands running it for each `A`. */
type LocalCommand<App, A extends Action.Any, Subcommands = never> = Command.Command<
  string,
  Subcommands,
  {},
  A["errors"][number]["Type"] | BuildError<App> | Action.Refusal | Schema.SchemaError,
  Exclude<RequestOf<App, A> | BuildContext<App>, Scope.Scope>
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
 * Build the implementation's handlers in a scope of their own, run one action through its
 * hook and its handler, and release them: every local command, selected or aggregated.
 */
const local = <App extends AnyImplementation, A extends Action.Any>(
  app: App,
  action: A,
  input: A["input"]["Type"],
): Local<App, A> =>
  // SAFETY: the builder's failures and services are the implementation's `EX` and `RX`,
  // the handler's and the hook's are its entry of `R`, and the hook refuses with a `Refusal`.
  Effect.scoped(
    Effect.flatMap(acquire([app]), (bound) => {
      const [, run] = bound.find(([candidate]) => candidate === action) ?? [];

      return run === undefined ? Effect.die(`No handler for ${action.name}`) : run(input);
    }).pipe(Effect.provide(Implementation.layerOf(app))),
  ) as Local<App, A>;

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
 * HTTP through its `ActionHttp.client` method, on the host's `HttpClient`. From
 * implementations, it runs the handler in process, behind its implementation's `before`
 * hook; the host provides the identity.
 */
export function command<const H extends AnyHttp, A extends H["actions"][number]>(
  http: H,
  action: A,
  options?: CommandOptions<A> & ClientOptions,
): RemoteCommand<H, A>;
export function command<const Apps extends Served, A extends ActionOf<Member<Apps>>>(
  apps: Apps,
  action: A,
  options?: CommandOptions<A>,
): LocalCommand<Selected<Member<Apps>, A>, A>;
export function command(
  target: AnyHttp | Served,
  action: Action.Any,
  options?: ErasedOptions,
): Command.Command<string, never, {}, unknown, unknown> {
  if (isHttp(target)) return remote(target, action, options);

  const app = select(toList(target), action);

  return makeCommand(action, (input) => local(app, action, input), options);
}

/**
 * Project every action as a subcommand of one aggregate command, each named after its
 * action in kebab case: each action of an HTTP binding called over HTTP, or each
 * implemented action run in process.
 */
export function make<const H extends AnyHttp>(
  http: H,
  options: MakeOptions & ClientOptions,
): RemoteCommand<H, H["actions"][number], {}>;
export function make<const Apps extends Served>(
  apps: Apps,
  options: MakeOptions,
): LocalCommand<Member<Apps>, ActionOf<Member<Apps>>, {}>;
export function make(
  target: AnyHttp | Served,
  options: ErasedOptions & MakeOptions,
): Command.Command<string, {}, {}, unknown, unknown> {
  const { baseUrl, transformClient } = options;

  // One subcommand per action: called over HTTP, or run by its own implementation.
  const subcommands = isHttp(target)
    ? target.actions.map((action) => ({
        action,
        command: remote(target, action, { baseUrl, transformClient }),
      }))
    : toList(target).flatMap((app) =>
        app.actions.map((action) => ({
          action,
          command: makeCommand(action, (input) => local(app, action, input)),
        })),
      );

  // An action served twice has one kebab-case name twice, so this refuses it too.
  assertDistinct(
    "command",
    subcommands,
    ({ action }) => kebab(action.name),
    ({ action }) => `action ${action.name}`,
  );

  // SAFETY: every subcommand runs or calls one action, so the aggregate's channels are
  // the unions `Local` and `RemoteCommand` state over them.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dynamic subcommand list.
  return Command.make(options.name).pipe(
    Command.withSubcommands(subcommands.map(({ command }) => command)),
  ) as never;
}
