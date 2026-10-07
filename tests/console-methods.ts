// Every `Console` method, called as a stdio server's code calls them: for `stdio.test.ts`,
// in memory and through `stdio-console.ts` in a real subprocess.
import { Console, Effect } from "effect";

/**
 * Call every method of the current console, Effect's scoped group and timer among them, with
 * `pause(millis)` wherever a timer runs.
 */
export const everyConsoleMethod = (pause: (millis: number) => Effect.Effect<void>) =>
  Console.consoleWith((console) =>
    Effect.gen(function* () {
      console.log("log");
      console.info("info");
      console.debug("debug");
      console.warn("warn");
      console.error("error");
      console.dirxml("dirxml");
      console.dir({ dir: true }, { depth: 0 });
      console.table([{ table: 1 }]);
      console.assert(true, "assert passed");
      console.assert(false, "assert %s", "failed");
      console.trace("trace");
      console.clear();

      console.count();
      console.count();
      console.count("calls");
      console.countReset("calls");
      console.count("calls");
      console.countReset("missing");

      // A label holding a format specifier, printed as it is.
      console.time("timer %s");
      console.time("timer %s");
      yield* pause(250);
      console.timeLog("timer %s", "logged");
      yield* pause(1250);
      console.timeEnd("timer %s");
      console.timeEnd("timer %s");
      console.timeLog("timer %s");

      console.group("group");
      console.log("inside");
      console.groupCollapsed("collapsed");
      console.log("deeper\nsecond line");
      console.log({ nested: true });
      console.dir("dir\nvalue");
      console.groupEnd();
      console.groupEnd();
      console.groupEnd();

      yield* Console.withGroup(Console.log("unlabeled"));
      yield* Console.withTime(pause(250), "scoped");
      console.log("after");
    }),
  );
