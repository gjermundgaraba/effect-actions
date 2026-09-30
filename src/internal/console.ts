import { Clock, Console, Effect, Predicate } from "effect";
import { constVoid } from "effect/Function";

/** What a group indents the output inside it by, as Node's console does. */
const groupIndentation = "  ";

/**
 * A timer's elapsed time as Node's console prints it below a minute: in milliseconds, from a
 * second in seconds. Past a minute it stays in seconds, where Node's console prints minutes.
 */
const elapsed = (nanos: bigint): string => {
  const millis = Number(nanos) / 1e6;

  return millis < 1000 ? `${Number(millis.toFixed(3))}ms` : `${(millis / 1000).toFixed(3)}s`;
};

/**
 * The console of code whose program's stdout carries data: a stdio server's protocol, or a
 * CLI command's result. Every method writes through `console.error` alone, so every console
 * logger, `Console.log` and the default logger alike, leaves stdout intact, and so do
 * counters, timers and group labels, which Node's console prints on stdout. Counts, timers,
 * read on `clock`, and group indentation are this console's own, with Node's labels, defaults
 * and warnings. What `error` cannot rebuild is left out: a group indents only the first line
 * of a value the console inspects, a timer prints seconds past a minute, `dir` takes no
 * inspect options, `table` prints its data without a grid or column filter, and `clear`
 * clears nothing.
 */
const stderrConsole = (console: Console.Console, clock: Clock.Clock): Console.Console => {
  const counts = new Map<string, number>();
  const timers = new Map<string, bigint>();
  let indent = "";

  // Indented by the open groups: every line of a first string argument, which the console
  // prints as it is, and the first line of anything else, so no value it prints is changed.
  const write = (...args: ReadonlyArray<unknown>) => {
    const [first, ...rest] = args;

    if (args.length === 0) {
      console.error(indent);
    } else if (Predicate.isString(first)) {
      console.error(indent + first.replaceAll("\n", `\n${indent}`), ...rest);
    } else {
      // The console joins arguments with a space, so one space less indents one it inspects.
      console.error(...(indent === "" ? [] : [indent.slice(1)]), first, ...rest);
    }
  };

  // Node emits these as process warnings, outside any group.
  const warning = (message: string) => console.error(`Warning: ${message}`);

  const report = (method: "timeLog" | "timeEnd", label: string, data: ReadonlyArray<unknown>) => {
    const start = timers.get(label);

    if (start === undefined) {
      warning(`No such label '${label}' for console.${method}()`);
    } else {
      write("%s: %s", label, elapsed(clock.monotonicTimeNanosUnsafe() - start), ...data);
    }
  };

  // Effect's `Console.group` passes a missing label as `undefined`: a group without a label.
  const group = (...label: ReadonlyArray<unknown>) => {
    if (label.some((part) => part !== undefined)) write(...label);

    indent += groupIndentation;
  };

  return {
    assert: (condition, ...args: ReadonlyArray<unknown>) => {
      const [first, ...rest] = args;

      if (!condition) {
        write(
          ...(Predicate.isString(first)
            ? [`Assertion failed: ${first}`, ...rest]
            : ["Assertion failed", ...args]),
        );
      }
    },
    // Node clears only a terminal on stdout, which here carries data.
    clear: constVoid,
    count: (label = "default") => {
      const count = (counts.get(label) ?? 0) + 1;

      counts.set(label, count);
      write(`${label}: ${count}`);
    },
    countReset: (label = "default") => {
      if (!counts.delete(label)) warning(`Count for '${label}' does not exist`);
    },
    debug: write,
    dir: (item) => write("%O", item),
    dirxml: write,
    error: write,
    group,
    groupCollapsed: group,
    groupEnd: () => {
      indent = indent.slice(groupIndentation.length);
    },
    info: write,
    log: write,
    table: (data) => write(data),
    time: (label = "default") => {
      if (timers.has(label)) {
        warning(`Label '${label}' already exists for console.time()`);
      } else {
        timers.set(label, clock.monotonicTimeNanosUnsafe());
      }
    },
    timeEnd: (label = "default") => {
      report("timeEnd", label, []);
      timers.delete(label);
    },
    timeLog: (label = "default", ...data: ReadonlyArray<unknown>) => report("timeLog", label, data),
    trace: (...args: ReadonlyArray<unknown>) => {
      const [first, ...rest] = args;
      // The caller's stack: without the header line and this function's own frame.
      const { stack = "" } = new Error();
      const frames = stack.split("\n").slice(2).join("\n");

      write(
        ...(args.length === 0
          ? ["Trace"]
          : Predicate.isString(first)
            ? [`Trace: ${first}`, ...rest]
            : ["Trace:", ...args]),
      );

      if (frames !== "") write(frames);
    },
    warn: write,
  };
};

/**
 * `effect` writing its console output and Effect logs to stderr alone, through the console
 * it runs with: for what a surface runs where stdout carries data, a stdio server's program
 * or a CLI command's builder, hook and handler.
 */
export const onStderr = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideServiceEffect(
    effect,
    Console.Console,
    Effect.zipWith(Effect.service(Console.Console), Effect.service(Clock.Clock), stderrConsole),
  );
