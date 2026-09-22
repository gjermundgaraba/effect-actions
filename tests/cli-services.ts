import { Effect, FileSystem, Layer, Path, Stdio, Terminal } from "effect";
import { TestConsole } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";

/** Every service `Command.runWith` needs, with no terminal input and no subprocesses. */
export const cliServices = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Stdio.layerTest({}),
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

/** Run a CLI program against the native test console: its result, then every line it logged. */
export const logged = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.all([program, TestConsole.logLines]).pipe(Effect.provide(TestConsole.layer));
