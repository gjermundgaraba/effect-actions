import {
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Stdio,
  Stream,
  Terminal,
} from "effect";
import { CliError, Command } from "effect/cli";
import { TestConsole } from "effect/testing";
import { ChildProcessSpawner } from "effect/process";

export type Stdin = string | { readonly terminal: true };

const cliServices = (stdin: Stdin) =>
  Layer.mergeAll(
    FileSystem.layerNoop({}),
    Path.layer,
    Stdio.layerTest(
      Predicate.isString(stdin)
        ? { stdin: Stream.make(new TextEncoder().encode(stdin)) }
        : { stdinIsTerminal: Effect.succeed(true) },
    ),
    Layer.succeed(
      Terminal.Terminal,
      Terminal.make({
        columns: Effect.succeed(80),
        rows: Effect.succeed(24),
        readInput: Effect.die("unused"),
        readLine: Effect.die("unused"),
        display: () => Effect.void,
      }),
    ),
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("unused")),
    ),
  );

export const exec = <const Name extends string, Input, E, R, ContextInput>(
  command: Command.Command<Name, Input, ContextInput, E, R>,
  args: ReadonlyArray<string>,
  { stdin = "", ...options }: { readonly renderErrors?: boolean; readonly stdin?: Stdin } = {},
) =>
  Command.runWith(command, { version: "0", ...options })(args).pipe(
    Effect.provide(cliServices(stdin)),
  );

export const logged = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.all([program, TestConsole.logLines]).pipe(
    Effect.provide(TestConsole.layer, { local: true }),
  );

export const printed = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.all([Effect.exit(program), TestConsole.logLines, TestConsole.errorLines]).pipe(
    Effect.provide(TestConsole.layer, { local: true }),
  );

export const causeOf = <A, E>(exit: Exit.Exit<A, E>) => {
  const error = Option.getOrUndefined(Exit.findErrorOption(exit));

  if (!(error instanceof CliError.UserError)) throw new Error(`Not a UserError: ${String(exit)}`);

  return error.cause;
};
