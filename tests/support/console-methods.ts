import { Console, Effect } from "effect";

const formatSpecifierLabel = "timer %s";

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

      console.time(formatSpecifierLabel);
      yield* pause(250);
      console.time(formatSpecifierLabel);
      console.timeLog(formatSpecifierLabel, "logged");
      yield* pause(1250);
      console.timeEnd(formatSpecifierLabel);
      console.timeEnd(formatSpecifierLabel);
      console.timeLog(formatSpecifierLabel);

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
