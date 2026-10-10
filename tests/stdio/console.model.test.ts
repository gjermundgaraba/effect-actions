import { Console as NodeConsole } from "node:console";
import { Writable } from "node:stream";
import { expect, it } from "@effect/vitest";
import { Arbitrary, Console, Effect, Match, Schema } from "effect";
import { withStderrConsole } from "../../src/stdio/console.js";

const formatLooking = Schema.Literals([
  "%s",
  "%d",
  "%i",
  "%f",
  "%j",
  "%o",
  "%O",
  "%c",
  "%%",
  "a %s b %d",
]);

const Argument = Schema.Union([formatLooking, Schema.String, Schema.Number]);

const Arguments = Schema.Array(Argument).check(Schema.isMaxLength(4));

const labelPool = Schema.Literals(["default", "a", "%s", "%d", "%%", "b\n%i"]);

const Command = Schema.Union([
  Schema.TaggedStruct("Write", {
    method: Schema.Literals(["log", "info", "warn", "error", "debug", "dirxml"]),
    args: Arguments,
  }),
  Schema.TaggedStruct("Assert", { condition: Schema.Boolean, args: Arguments }),
  Schema.TaggedStruct("Dir", { item: Argument }),
  Schema.TaggedStruct("Count", {
    method: Schema.Literals(["count", "countReset"]),
    label: Schema.optionalKey(labelPool),
  }),
  Schema.TaggedStruct("Group", {
    method: Schema.Literals(["group", "groupCollapsed"]),
    label: Schema.optionalKey(labelPool),
  }),
  Schema.TaggedStruct("GroupEnd", {}),
  Schema.TaggedStruct("Clear", {}),
  Schema.TaggedStruct("Time", { label: Schema.optionalKey(labelPool) }),
  Schema.TaggedStruct("TimeLog", { label: Schema.optionalKey(labelPool), data: Arguments }),
  Schema.TaggedStruct("TimeEnd", { label: Schema.optionalKey(labelPool) }),
]);

type Command = typeof Command.Type;

const consoleCommands = Arbitrary.array(Arbitrary.schema(Command), {
  maxLength: 60,
});

const memorySink = () => {
  const chunks: Array<string> = [];

  const stream = new Writable({
    write: (chunk: Buffer, _encoding, done) => {
      chunks.push(chunk.toString());
      done();
    },
  });

  return { stream, take: () => chunks.splice(0).join("") };
};

const nodeOracle = () => {
  const sink = memorySink();

  const node = new NodeConsole({
    stdout: sink.stream,
    stderr: sink.stream,
    colorMode: false,
    groupIndentation: 0,
  });

  const countersNodeHolds = new Set<string>();

  const timersNodeHolds = new Set<string>();

  const run = Match.type<Command>().pipe(
    Match.tagsExhaustive({
      Write: ({ method, args }) => node[method](...args),
      Assert: ({ condition, args }) => node.assert(condition, ...args),
      Dir: ({ item }) => node.dir(item),
      Count: ({ method, label }) => {
        if (method === "count") {
          countersNodeHolds.add(label ?? "default");
          node.count(label);
        } else if (countersNodeHolds.delete(label ?? "default")) node.countReset(label);
      },
      Group: ({ method, label }) => (label === undefined ? node[method]() : node[method](label)),
      GroupEnd: () => node.groupEnd(),
      Clear: () => node.clear(),
      Time: ({ label }) => {
        if (!timersNodeHolds.has(label ?? "default")) {
          timersNodeHolds.add(label ?? "default");
          node.time(label);
        }
      },
      TimeLog: ({ label, data }) => {
        if (timersNodeHolds.has(label ?? "default")) node.timeLog(label, ...data);
      },
      TimeEnd: ({ label }) => {
        if (timersNodeHolds.delete(label ?? "default")) node.timeEnd(label);
      },
    }),
  );

  return (command: Command) => {
    run(command);

    return sink.take();
  };
};

const runOnLibrary = (library: Console.Console) =>
  Match.type<Command>().pipe(
    Match.tagsExhaustive({
      Write: ({ method, args }) => library[method](...args),
      Assert: ({ condition, args }) => library.assert(condition, ...args),
      Dir: ({ item }) => library.dir(item),
      Count: ({ method, label }) => library[method](label),
      Group: ({ method, label }) =>
        label === undefined ? library[method]() : library[method](label),
      GroupEnd: () => library.groupEnd(),
      Clear: () => library.clear(),
      Time: ({ label }) => library.time(label),
      TimeLog: ({ label, data }) => library.timeLog(label, ...data),
      TimeEnd: ({ label }) => library.timeEnd(label),
    }),
  );

const normalizeElapsed = (label: string | undefined, written: string) => {
  const prefix = `${label ?? "default"}: `;

  return written.startsWith(prefix)
    ? prefix + written.slice(prefix.length).replace(/^\d+(?:\.\d+)?(?:ms|s)/u, "<elapsed>")
    : written;
};

const withElapsedNormalized = (command: Command, written: string) =>
  Match.value(command).pipe(
    Match.tags({
      TimeLog: ({ label }) => normalizeElapsed(label, written),
      TimeEnd: ({ label }) => normalizeElapsed(label, written),
    }),
    Match.orElse(() => written),
  );

const libraryOverNodeConsole = (stdout: Writable, stderr: Writable) =>
  withStderrConsole(Console.consoleWith(Effect.succeed)).pipe(
    Effect.provideService(
      Console.Console,
      new NodeConsole({ stdout, stderr, colorMode: false, groupIndentation: 0 }),
    ),
  );

it.effect.prop(
  "writes to stderr what Node's console writes to either stream, without group indentation, timers' elapsed time normalized, and nothing to stdout",
  [consoleCommands],
  ([commands]) =>
    Effect.gen(function* () {
      const stdout = memorySink();

      const stderr = memorySink();

      const library = yield* libraryOverNodeConsole(stdout.stream, stderr.stream);

      const oracle = nodeOracle();

      const run = runOnLibrary(library);

      const writtenToStderr = commands.map((command) => {
        run(command);

        return withElapsedNormalized(command, stderr.take());
      });

      const nodeWrites = commands.map((command) => withElapsedNormalized(command, oracle(command)));

      expect(stdout.take()).toBe("");
      expect(writtenToStderr).toEqual(nodeWrites);
    }),
  { arbitrary: { runs: 1000, size: 120 } },
);
