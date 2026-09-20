import { Console, Effect, FileSystem, Layer, Path, Stdio, Terminal } from "effect";
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

/** The real console, except that `log` collects each message into `output`. */
export const capturingConsole = (output: string[]) =>
  ({
    assert: console.assert.bind(console),
    clear: console.clear.bind(console),
    count: console.count.bind(console),
    countReset: console.countReset.bind(console),
    debug: console.debug.bind(console),
    dir: console.dir.bind(console),
    dirxml: console.dirxml.bind(console),
    error: console.error.bind(console),
    group: console.group.bind(console),
    groupCollapsed: console.groupCollapsed.bind(console),
    groupEnd: console.groupEnd.bind(console),
    info: console.info.bind(console),
    log: (message: string) => output.push(message),
    table: console.table.bind(console),
    time: console.time.bind(console),
    timeEnd: console.timeEnd.bind(console),
    timeLog: console.timeLog.bind(console),
    trace: console.trace.bind(console),
    warn: console.warn.bind(console),
  }) satisfies Console.Console;
