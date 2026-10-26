import { assert, describe, expect, it } from "@effect/vitest";
import {
  Arbitrary,
  Context,
  Effect,
  Exit,
  Logger,
  References,
  Schema,
  SchemaTransformation,
  Stream,
  Tracer,
} from "effect";
import * as Action from "../../src/contract/Action.js";
import { actors, CurrentActor } from "../support/app/authorization.js";
import { defectOf } from "../support/defect.js";
import { recordSpans } from "../support/tracing.js";

class LogGone extends Schema.TaggedError<LogGone>()("LogGone", { at: Schema.Finite }) {}

const Trimmed = Schema.String.pipe(Schema.decodeTo(Schema.String, SchemaTransformation.trim()));

const Line = Schema.Struct({ n: Schema.Finite, text: Trimmed, at: Schema.Date });

const Tail = Action.make("tail", {
  description: "Follow lines, failing where the log is gone.",
  input: { lines: Schema.Array(Line), goneAt: Schema.optional(Schema.Finite) },
  success: Action.Stream(Line),
  error: LogGone,
  readOnly: true,
  caller: Action.Anyone,
});

const padded = (lines: ReadonlyArray<typeof Line.Type>) =>
  Stream.fromIterable(lines.map((line) => ({ ...line, text: ` ${line.text} ` })));

const tails = Action.implement(Tail, ({ lines, goneAt }) =>
  goneAt === undefined
    ? padded(lines)
    : Stream.concat(padded(lines.slice(0, goneAt)), Stream.fail(new LogGone({ at: goneAt }))),
);

describe("an action answering a stream, in process", () => {
  it.effect.prop(
    "streams the generated elements its handler gives, as JSON carries them: text trimmed, -0 as 0",
    [Arbitrary.schema(Schema.Array(Line))],
    ([lines]) =>
      Effect.gen(function* () {
        const client = yield* Action.client(tails);

        const elements = yield* Stream.runCollect(client.tail({ lines }));

        expect(elements).toEqual(
          lines.map((line) => ({ ...line, n: line.n + 0, text: line.text.trim() })),
        );
      }),
    { arbitrary: { runs: 100 } },
  );

  it.effect("streams the elements before a declared failure, then fails with it", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(tails);
      const lines = [0, 1, 2].map((n) => ({ n, text: `line ${n}`, at: new Date(n) }));
      const seen: Array<number> = [];

      const failure = yield* Effect.flip(
        Stream.runForEach(client.tail({ lines, goneAt: 2 }), ({ n }) =>
          Effect.sync(() => seen.push(n)),
        ),
      );

      expect([seen, failure]).toEqual([[0, 1], new LogGone({ at: 2 })]);
    }),
  );

  it.effect("ends at once for a handler giving no element", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(tails);

      expect(yield* Stream.runCollect(client.tail({ lines: [] }))).toEqual([]);
    }),
  );

  it.effect("makes an undeclared failure and an element breaking its schema defects", () =>
    Effect.gen(function* () {
      const undeclared = new Error("undeclared");

      const failing = yield* Action.client(
        // @ts-expect-error -- An undeclared failure, as a handler the types were bypassed for gives it.
        Action.implement(Tail, () => Stream.fail(undeclared)),
      );

      const breaking = yield* Action.client(
        // @ts-expect-error -- An element breaking its schema, as a handler the types were bypassed for gives it.
        Action.implement(Tail, () => Stream.make({ n: "one" })),
      );

      expect(yield* defectOf(Stream.runDrain(failing.tail({ lines: [] })))).toBe(undeclared);
      expect(yield* defectOf(Stream.runDrain(breaking.tail({ lines: [] })))).toBeInstanceOf(
        Schema.SchemaError,
      );
    }),
  );

  it.effect("runs the handler's stream in a scope its consumer's early end closes", () =>
    Effect.gen(function* () {
      const released: Array<string> = [];

      const Count = Action.make("count", {
        description: "Count forever.",
        success: Action.Stream(Schema.Finite),
        readOnly: true,
        caller: Action.Anyone,
      });

      const client = yield* Action.client(
        Action.implement(Count, () =>
          Stream.concat(
            Stream.fromEffect(
              Effect.as(
                Effect.addFinalizer(() => Effect.sync(() => released.push("counter"))),
                0,
              ),
            ),
            Stream.iterate(1, (n) => n + 1),
          ),
        ),
      );

      expect(yield* Stream.runCollect(Stream.take(client.count(), 3))).toEqual([0, 1, 2]);
      expect(released).toEqual(["counter"]);
    }),
  );

  it.effect("refuses a protected stream before its handler runs, then streams as the caller", () =>
    Effect.gen(function* () {
      let started = 0;

      const Watched = Action.make("watched", {
        description: "Follow who is watching.",
        success: Action.Stream({ id: Schema.String }),
        readOnly: false,
        caller: CurrentActor,
      });

      const client = yield* Action.client(
        Action.implement(
          Watched,
          () => {
            started += 1;

            return Stream.fromEffect(Effect.map(CurrentActor, ({ id }) => ({ id })));
          },
          {
            authorize: () =>
              Effect.flatMap(CurrentActor, ({ id }) =>
                id === "alice" ? Effect.void : Effect.fail(new Action.Forbidden()),
              ),
          },
        ),
      );

      const refused = yield* Effect.flip(
        Stream.runDrain(client.watched()).pipe(Effect.provideService(CurrentActor, actors.reader)),
      );

      const streamed = yield* Stream.runCollect(client.watched()).pipe(
        Effect.provideService(CurrentActor, actors.alice),
      );

      expect([refused, started, streamed]).toEqual([new Action.Forbidden(), 1, [{ id: "alice" }]]);
    }),
  );

  it.effect("hands progress to onProgress beside the elements, all of it before the end", () =>
    Effect.gen(function* () {
      const Build = Action.make("build", {
        description: "Stream a build's lines, reporting its step.",
        input: { steps: Schema.Finite },
        success: Action.Stream({ line: Schema.String }),
        progress: { step: Schema.Finite },
        readOnly: false,
        caller: Action.Anyone,
      });

      const client = yield* Action.client(
        Action.implement(Build, ({ steps }, { progress }) =>
          Stream.mapEffect(Stream.range(1, steps), (step) =>
            Effect.as(progress({ step }), { line: `step ${step}` }),
          ),
        ),
      );

      const reported: Array<number> = [];

      const lines = yield* Stream.runCollect(
        client.build(
          { steps: 3 },
          { onProgress: ({ step }) => Effect.sync(() => reported.push(step)) },
        ),
      );

      expect([lines, reported]).toEqual([
        [{ line: "step 1" }, { line: "step 2" }, { line: "step 3" }],
        [1, 2, 3],
      ]);
    }),
  );

  it.effect("spans the stream's run and annotates the handler's logs with the action", () => {
    const { spans, tracer } = recordSpans();

    const logs: Array<Context.Service.Shape<typeof References.CurrentLogAnnotations>> = [];

    const logger = Logger.make(({ fiber }) => {
      logs.push(fiber.getRef(References.CurrentLogAnnotations));
    });

    return Effect.gen(function* () {
      const client = yield* Action.client(
        Action.implement(Tail, ({ lines }) =>
          Stream.tap(Stream.fromIterable(lines), () => Effect.log("line")),
        ),
      );

      const line = { n: 0, text: "", at: new Date(0) };
      const exit = yield* Effect.exit(Stream.runDrain(client.tail({ lines: [line] })));

      assert(Exit.isSuccess(exit));
      expect(spans.get("tail")?.status).toMatchObject({ _tag: "Ended" });
      expect(logs).toEqual([{ "action.name": "tail", "action.read_only": true }]);
    }).pipe(Effect.provideService(Tracer.Tracer, tracer), Effect.provide(Logger.layer([logger])));
  });

  it.effect("fails with a defect where a handler answers a value for a stream", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(
        // @ts-expect-error -- A value for a stream, as a handler the types were bypassed for gives it.
        Action.implement(Tail, () => Effect.succeed({ n: 0, text: "", at: new Date(0) })),
      );

      const defect = yield* defectOf(Stream.runDrain(client.tail({ lines: [] })));

      expect(defect).toEqual(
        new Error("A handler answered otherwise than its action's success declares"),
      );
    }),
  );

  it.effect("fails with a defect where a handler answers a stream for a value", () =>
    Effect.gen(function* () {
      const Ping = Action.make("ping", {
        description: "Answer one number.",
        success: Schema.Finite,
        readOnly: true,
        caller: Action.Anyone,
      });

      const client = yield* Action.client(
        // @ts-expect-error -- A stream for a value, as a handler the types were bypassed for gives it.
        Action.implement(Ping, () => Stream.make(1)),
      );

      expect(String(yield* defectOf(client.ping()))).toContain("answered otherwise");
    }),
  );
});
