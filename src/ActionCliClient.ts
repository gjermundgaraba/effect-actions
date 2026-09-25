import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import type { HttpClient } from "effect/unstable/http";
import type * as Action from "./Action.js";
import { command as makeCommand, type Options as CliOptions } from "./internal/cli.js";
import {
  type AnyHttp,
  type ErrorsOf,
  type MethodError,
  methods,
  type Options as Connection,
} from "./internal/client.js";

/** What the host configures on the client: `baseUrl` and `transformClient`. */
export type { Connection };

/** Parsing, rendering and client configuration for one remote action. */
export type Options<Output, ParsedParameters extends Command.Command.Config = never> = CliOptions<
  Output,
  ParsedParameters
> & {
  readonly connection?: Connection;
};

/** Configuration for a remote aggregate command. */
export interface MakeOptions {
  /** The aggregate command's name. */
  readonly name: string;
  /** Client configuration shared by every remote action. */
  readonly connection?: Connection;
}

/** What one remote action's command fails with: exactly what its client method fails with. */
type RemoteError<A extends Action.Any, H> = MethodError<A, ErrorsOf<H>>;

/** A native command for one remote action. */
type RemoteCommand<A extends Action.Any, H> = Command.Command<
  string,
  never,
  {},
  RemoteError<A, H>,
  HttpClient.HttpClient
>;

/** An aggregate of remote commands. */
type RemoteMake<H extends AnyHttp> = Command.Command<
  string,
  {},
  {},
  RemoteError<H["actions"][number], H>,
  HttpClient.HttpClient
>;

/** One remote command, its failures erased; the public constructors restore them. */
const remote = <A extends Action.Any, ParsedParameters extends Command.Command.Config>(
  http: AnyHttp,
  action: A,
  options: Options<A["success"]["Type"], ParsedParameters> | undefined,
) => {
  if (!http.actions.includes(action)) {
    throw new Error(`Action "${action.name}" is not in this HTTP binding`);
  }

  return makeCommand(
    action,
    (input) =>
      Effect.flatMap(methods(http, options?.connection), (methodOf) => methodOf(action)(input)),
    options,
  );
};

/**
 * Project one action of the binding, selected by its contract, into a native Effect CLI
 * command that calls it over HTTP through `ActionHttpClient`. The native client is the
 * host's `HttpClient`.
 */
export const command = <
  const H extends AnyHttp,
  A extends H["actions"][number],
  ParsedParameters extends Command.Command.Config = never,
>(
  http: H,
  action: A,
  options?: Options<A["success"]["Type"], ParsedParameters>,
): RemoteCommand<A, H> =>
  // The command fails with exactly what the action's client method fails with, which
  // `RemoteCommand` states from the action and the binding's errors.
  remote(http, action, options);

/** Project every action of the binding as a subcommand of one aggregate command. */
export const make = <const H extends AnyHttp>(http: H, options: MakeOptions): RemoteMake<H> => {
  const connection = options.connection === undefined ? {} : { connection: options.connection };

  // Every subcommand is a command of this binding, whose failures are those of its
  // action's client method; the aggregate's are their union.
  return Command.make(options.name).pipe(
    Command.withSubcommands(http.actions.map((action) => remote(http, action, connection))),
  );
};
