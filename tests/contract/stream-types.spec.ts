import { describe, expectTypeOf, it } from "@effect/vitest";
import { Context, Effect, Schema, Stream } from "effect";
import * as Action from "../../src/contract/Action.js";

class LogGone extends Schema.TaggedError<LogGone>()("LogGone", {}) {}

class Logs extends Context.Service<Logs, string>()("stream-types/Logs") {}

const Tail = Action.make("tail", {
  description: "Follow a log.",
  input: { id: Schema.String },
  success: Action.Stream({ line: Schema.String }),
  error: LogGone,
  readOnly: true,
  caller: Action.Anyone,
});

const Build = Action.make("build", {
  description: "Follow a build, reporting its step.",
  success: Action.Stream(Schema.String),
  progress: { step: Schema.Finite },
  readOnly: false,
  caller: Action.Anyone,
});

describe("Action.Stream", () => {
  it("types the success as a schema of streams of the element", () => {
    expectTypeOf(Tail.success.element.Type).toEqualTypeOf<{ readonly line: string }>();
    expectTypeOf(Tail.success.Type).toEqualTypeOf<Stream.Stream<{ readonly line: string }>>();
  });

  it("keeps the stream's type through an annotation", () => {
    const Lines = Action.make("lines", {
      description: "Follow lines.",
      success: Action.Stream(Schema.String).annotate({ description: "Lines." }),
      readOnly: true,
      caller: Action.Anyone,
    });

    expectTypeOf(Lines.success).toEqualTypeOf<Action.StreamOf<typeof Schema.String>>();
    expectTypeOf<Action.Handler<typeof Lines>>().returns.toEqualTypeOf<
      Stream.Stream<string, Action.BuiltIn>
    >();
  });

  it("takes a handler returning a stream of the element, failing with the declared errors", () => {
    const tails = Action.implement(Tail, ({ id }) =>
      Stream.fromEffect(Effect.map(Logs, (log) => ({ line: `${id}: ${log}` }))),
    );

    expectTypeOf<Action.Handler<typeof Tail>>().returns.toEqualTypeOf<
      Stream.Stream<{ readonly line: string }, LogGone | Action.BuiltIn>
    >();

    Action.implement(Tail, () => Stream.fail(new LogGone()));
    Action.implement(Build, (_input, { progress }) =>
      Stream.as(Stream.fromEffect(progress({ step: 1 })), "line"),
    );

    // @ts-expect-error -- A value where the action answers a stream.
    Action.implement(Tail, () => Effect.succeed({ line: "" }));

    // @ts-expect-error -- An element of another shape.
    Action.implement(Tail, () => Stream.make({ line: 1 }));

    // @ts-expect-error -- A failure the action does not declare.
    Action.implement(Tail, () => Stream.fail(new Error("undeclared")));

    return tails;
  });

  it("gives each client method a stream, owing what the handler's stream reads", () =>
    Effect.gen(function* () {
      const client = yield* Action.client([
        Action.implement(Tail, () => Stream.fromEffect(Effect.as(Logs, { line: "" }))),
        Action.implement(Build, () => Stream.empty),
      ]);

      const tailed = client.tail({ id: "a" });

      expectTypeOf<Stream.Success<typeof tailed>>().toEqualTypeOf<{ readonly line: string }>();
      expectTypeOf<Stream.Error<typeof tailed>>().toEqualTypeOf<LogGone | Action.BuiltIn>();
      expectTypeOf<Stream.Services<typeof tailed>>().toEqualTypeOf<Logs>();

      const built = client.build({}, { onProgress: ({ step }) => Effect.log(step) });

      expectTypeOf<Stream.Success<typeof built>>().toEqualTypeOf<string>();

      // @ts-expect-error -- The input is the action's.
      void client.tail({ id: 1 });
    }));
});
