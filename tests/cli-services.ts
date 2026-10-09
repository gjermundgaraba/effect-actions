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

/** What a run reads on stdin: text piped in, empty by default, or a terminal. */
export type Stdin = string | { readonly terminal: true };

/**
 * Every service `Command.runWith` needs, with `stdin` piped in or a terminal there, no
 * terminal input otherwise and no subprocesses.
 */
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

/**
 * Run `command` on `args`, as its binary would, with every service it needs but what its
 * actions need: a remote command's `HttpClient`, say. `stdin` is what it reads there.
 */
export const exec = <const Name extends string, Input, E, R, ContextInput>(
  command: Command.Command<Name, Input, ContextInput, E, R>,
  args: ReadonlyArray<string>,
  { stdin = "", ...options }: { readonly renderErrors?: boolean; readonly stdin?: Stdin } = {},
) =>
  Command.runWith(command, { version: "0", ...options })(args).pipe(
    Effect.provide(cliServices(stdin)),
  );

/**
 * Run a CLI program against a test console of its own: its result, then every line it logged.
 * Its own, so a test running several reads each one's lines: built `local`ly, since
 * `it.effect` has built `TestConsole.layer` for the test, which `provide` would reuse.
 */
export const logged = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.all([program, TestConsole.logLines]).pipe(
    Effect.provide(TestConsole.layer, { local: true }),
  );

/**
 * Run a CLI program against the native test console: its exit, then the lines it printed on
 * stdout, `Console.log`, and on stderr, `Console.error`.
 */
export const printed = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.all([Effect.exit(program), TestConsole.logLines, TestConsole.errorLines]).pipe(
    Effect.provide(TestConsole.layer, { local: true }),
  );

/**
 * What an action failed with, when its command failed: the `cause` of Effect CLI's
 * `UserError`, which `Command.run` prints. Any other failure, such as the parser's, fails
 * the test.
 */
export const causeOf = <A, E>(exit: Exit.Exit<A, E>) => {
  const error = Option.getOrUndefined(Exit.findErrorOption(exit));

  if (!(error instanceof CliError.UserError)) throw new Error(`Not a UserError: ${String(exit)}`);

  return error.cause;
};
