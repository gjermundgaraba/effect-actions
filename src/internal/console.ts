import { Clock, Console, Effect, Function, Predicate } from "effect";

/**
 * The console of code whose program's stdout carries data: a stdio server's protocol, or a
 * CLI command's result. Every method writes through `console.error` alone, so every console
 * logger, `Console.log` and the default logger alike, leaves stdout intact, and so do
 * counters, timers and group labels, which Node's console prints on stdout. A counter or a
 * timer prints its label as given, never as a format, then its count or the milliseconds
 * since it started, read on `clock` and rounded to three decimals; a group prints its label
 * without indenting what follows, and `clear` clears nothing.
 */
const stderrConsole = (console: Console.Console, clock: Clock.Clock): Console.Console => {
  const counts = new Map<string, number>();
  const timers = new Map<string, bigint>();
  const write = (...args: ReadonlyArray<unknown>) => console.error(...args);

  const elapsed = (label: string, data: ReadonlyArray<unknown>) => {
    const start = timers.get(label);

    if (start !== undefined) {
      const millis = Number(clock.monotonicTimeNanosUnsafe() - start) / 1e6;

      write("%s: %sms", label, Number(millis.toFixed(3)), ...data);
    }
  };

  // A label before what an assertion or a trace prints, joined to a first string argument
  // rather than given before it, so that string's format specifiers still apply.
  const labeled = (label: string, args: ReadonlyArray<unknown>) => {
    const [first, ...rest] = args;

    write(...(Predicate.isString(first) ? [`${label}: ${first}`, ...rest] : [label, ...args]));
  };

  // Effect's `Console.group` passes a missing label as `undefined`: a group without a label.
  const group = (...label: ReadonlyArray<unknown>) => {
    if (label.some((part) => part !== undefined)) write(...label);
  };

  return {
    assert: (condition, ...args: ReadonlyArray<unknown>) => {
      if (!condition) labeled("Assertion failed", args);
    },
    clear: Function.constVoid,
    count: (label = "default") => {
      const count = (counts.get(label) ?? 0) + 1;

      counts.set(label, count);
      write("%s: %d", label, count);
    },
    countReset: (label = "default") => {
      counts.delete(label);
    },
    debug: write,
    dir: (item) => write("%O", item),
    dirxml: write,
    error: write,
    group,
    groupCollapsed: group,
    groupEnd: Function.constVoid,
    info: write,
    log: write,
    table: (data) => write(data),
    time: (label = "default") => {
      timers.set(label, clock.monotonicTimeNanosUnsafe());
    },
    timeEnd: (label = "default") => {
      elapsed(label, []);
      timers.delete(label);
    },
    timeLog: (label = "default", ...data: ReadonlyArray<unknown>) => elapsed(label, data),
    // The caller's stack: without the header line and this function's own frame.
    trace: (...args: ReadonlyArray<unknown>) => {
      const { stack = "" } = new Error();
      const frames = stack.split("\n").slice(2).join("\n");

      labeled("Trace", args);

      if (frames !== "") write(frames);
    },
    warn: write,
  };
};

/**
 * `effect` writing its console output and Effect logs to stderr alone, through the console
 * it runs with: for what a surface runs where stdout carries data, a stdio server's program
 * or a CLI command's builder, authorizer and handler.
 */
export const logToStderr = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideServiceEffect(
    effect,
    Console.Console,
    Effect.zipWith(Effect.service(Console.Console), Effect.service(Clock.Clock), stderrConsole),
  );
