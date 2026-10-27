import { Clock, Console, Effect, Function, Predicate } from "effect";

// Why: Next to Node's console, `table` printing as `log` does, a timer's milliseconds past a
// second, a group without indentation and no warning for an unknown label are deliberate. Node's
// layouts are not rebuilt, as no stdio server or CLI needs them: it promises only that every method
// writes through `error`, counters and timers keeping their counts and start times.
const stderrConsole = (
  console: Console.Console,
  clock: Clock.Clock
): Console.Console => {
  const counts = new Map<string, number>();
  const timers = new Map<string, bigint>();

  const write = (...args: readonly unknown[]) => {
    console.error(...args);
  };

  const elapsed = (label: string, data: readonly unknown[]) => {
    const start = timers.get(label);

    if (start !== undefined) {
      const millis = Number(clock.monotonicTimeNanosUnsafe() - start) / 1e6;

      write("%s: %sms", label, Number(millis.toFixed(3)), ...data);
    }
  };

  const writeLabelKeepingFormat = (label: string, args: readonly unknown[]) => {
    const [formatOrFirst, ...rest] = args;

    write(
      ...(Predicate.isString(formatOrFirst)
        ? [`${label}: ${formatOrFirst}`, ...rest]
        : [label, ...args])
    );
  };

  const group = (...labelOrUndefined: readonly unknown[]) => {
    if (labelOrUndefined.some((part) => part !== undefined)) {
      write(...labelOrUndefined);
    }
  };

  return {
    assert: (condition, ...args: readonly unknown[]) => {
      if (!condition) {
        writeLabelKeepingFormat("Assertion failed", args);
      }
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
    dir: (item) => {
      write("%O", item);
    },
    dirxml: write,
    error: write,
    group,
    groupCollapsed: group,
    groupEnd: Function.constVoid,
    info: write,
    log: write,
    table: (data) => {
      write(data);
    },
    time: (label = "default") => {
      if (!timers.has(label)) {
        timers.set(label, clock.monotonicTimeNanosUnsafe());
      }
    },
    timeEnd: (label = "default") => {
      elapsed(label, []);
      timers.delete(label);
    },
    timeLog: (label = "default", ...data: readonly unknown[]) => {
      elapsed(label, data);
    },
    trace: (...args: readonly unknown[]) => {
      const { stack = "" } = new Error("console.trace");
      const [_header, _traceFrame, ...callerFrames] = stack.split("\n");
      const callerStack = callerFrames.join("\n");

      writeLabelKeepingFormat("Trace", args);

      if (callerStack !== "") {
        write(callerStack);
      }
    },
    warn: write,
  };
};

export const withStderrConsole = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.provideServiceEffect(
    effect,
    Console.Console,
    Effect.zipWith(
      Effect.service(Console.Console),
      Effect.service(Clock.Clock),
      stderrConsole
    )
  );
