import { Clock, Console, Effect, Function, Predicate } from "effect";

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

  const writeLabelKeepingFormat = (label: string, args: ReadonlyArray<unknown>) => {
    const [formatOrFirst, ...rest] = args;

    write(
      ...(Predicate.isString(formatOrFirst)
        ? [`${label}: ${formatOrFirst}`, ...rest]
        : [label, ...args]),
    );
  };

  const group = (...labelOrUndefined: ReadonlyArray<unknown>) => {
    if (labelOrUndefined.some((part) => part !== undefined)) write(...labelOrUndefined);
  };

  return {
    assert: (condition, ...args: ReadonlyArray<unknown>) => {
      if (!condition) writeLabelKeepingFormat("Assertion failed", args);
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
    trace: (...args: ReadonlyArray<unknown>) => {
      const { stack = "" } = new Error();
      const [_header, _traceFrame, ...callerFrames] = stack.split("\n");
      const callerStack = callerFrames.join("\n");

      writeLabelKeepingFormat("Trace", args);

      if (callerStack !== "") write(callerStack);
    },
    warn: write,
  };
};

/**
 * `effect` writing its console output and Effect logs to stderr alone, through the console
 * it runs with: for what a surface runs where stdout carries data, a stdio server's program
 * or a CLI command's builder, authorizer and handler.
 */
export const withStderrConsole = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.provideServiceEffect(
    effect,
    Console.Console,
    Effect.zipWith(Effect.service(Console.Console), Effect.service(Clock.Clock), stderrConsole),
  );
