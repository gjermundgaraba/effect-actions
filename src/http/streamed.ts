import { Cause, Effect, ErrorReporter, Queue, Schema, Stream } from "effect";
import { HttpServerRequest } from "effect/http";
import { HttpApiSchema } from "effect/http-api";

import type * as Action from "../contract/Action.js";
import type { Codec } from "../contract/codec.js";
import { elementsOf } from "../contract/implementation.js";
import type { ErasedHandler, ErasedValue } from "../contract/implementation.js";
import { answerFrom, elementsFrom, Progressed } from "../contract/progress.js";
import type { CallOptions, Reporting } from "../contract/progress.js";
import { concealed } from "../contract/reported.js";
import type { StreamOf } from "../contract/stream.js";

interface Sent {
  readonly event: "progress" | "element" | "final";
  readonly data: ErasedValue;
}

const eventOf = <const N extends Sent["event"], D extends Codec>(
  event: N,
  data: D
) =>
  Schema.Struct({
    id: Schema.optional(Schema.String),
    event: Schema.Literal(event),
    data: Schema.fromJsonString(Schema.toCodecJson(data)),
  });

type EventOf<N extends Sent["event"], D extends Codec> = ReturnType<
  typeof eventOf<N, D>
>;

/** The success of the endpoint of action `A` declaring errors `E`, as `ActionHttp` builds it. */
export type SuccessOf<A extends Action.Any, E extends Schema.Top> =
  A["success"] extends StreamOf<infer Element>
    ? HttpApiSchema.StreamSse<
        Schema.Union<
          A["progress"] extends Codec
            ? readonly [
                EventOf<"element", Element>,
                EventOf<"progress", A["progress"]>,
              ]
            : readonly [EventOf<"element", Element>]
        >,
        E
      >
    : A["progress"] extends Codec
      ?
          | Schema.toCodecJson<A["success"]>
          | HttpApiSchema.StreamSse<
              Schema.Union<
                readonly [
                  EventOf<"progress", A["progress"]>,
                  EventOf<"final", A["success"]>,
                ]
              >,
              E
            >
      : Schema.toCodecJson<A["success"]>;

export const answeredWithProgress = (success: Action.Any["success"]) =>
  HttpApiSchema.isNoContent(success.ast) ? HttpApiSchema.NoContent : success;

export const progressStreamOf = (
  progress: Codec,
  success: Action.Any["success"],
  errors: readonly Schema.Top[]
) =>
  HttpApiSchema.StreamSse({
    events: Schema.Union([
      eventOf("progress", progress),
      eventOf("final", success),
    ]),
    error: Schema.Union(errors),
  });

export const elementStreamOf = (
  element: Codec,
  progress: Codec | undefined,
  errors: readonly Schema.Top[]
) =>
  HttpApiSchema.StreamSse({
    events: Schema.Union(
      progress === undefined
        ? [eventOf("element", element)]
        : [eventOf("element", element), eventOf("progress", progress)]
    ),
    error: Schema.Union(errors),
  });

const gatedOnFirst = (sent: Queue.Queue<Sent, unknown>) =>
  Effect.map(
    Effect.catchIf(Queue.take(sent), Cause.isDone, () => Effect.undefined),
    (first) =>
      first === undefined
        ? Stream.empty
        : Stream.concat(Stream.make(first), Stream.fromQueue(sent))
  );

const streamed = (
  answer: (
    reporting: Reporting,
    send: (sent: Sent) => Effect.Effect<void>
  ) => Effect.Effect<void, unknown, unknown>
) =>
  Effect.gen(function* () {
    const sent = yield* Queue.bounded<Sent, unknown>(1);
    let streaming = false;

    const send = (event: Sent) =>
      Effect.andThen(
        Queue.offer(sent, event),
        Effect.sync(() => {
          streaming = true;
        })
      );

    const reporting: Reporting = {
      progress: (data) => send({ event: "progress", data }),
    };

    const endedReportingMidStream = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasDies(cause)) {
        return concealed(cause);
      }

      return streaming
        ? Effect.andThen(ErrorReporter.report(cause), Effect.failCause(cause))
        : Effect.failCause(cause);
    };

    yield* answer(reporting, send).pipe(
      Effect.catchCause(endedReportingMidStream),
      Queue.into(sent),
      Effect.forkScoped({ startImmediately: true })
    );

    return yield* gatedOnFirst(sent);
  });

const checkedBy = (schema: Codec) => {
  const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(schema));

  return (data: ErasedValue) => Effect.orDie(encode(data));
};

export const answeringWithProgress = (
  success: Action.Any["success"],
  run: ErasedHandler<unknown>
) => {
  const check = checkedBy(success);

  return (payload: ErasedValue) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      (request.headers["accept"] ?? "").includes("text/event-stream")
        ? streamed((reporting, send) =>
            run(payload, reporting).pipe(
              Effect.tap(check),
              Effect.flatMap((data) => send({ event: "final", data }))
            )
          )
        : run(payload)
    );
};

export const answeringElements = (
  element: Codec,
  run: ErasedHandler<unknown>
) => {
  const check = checkedBy(element);

  return (payload: ErasedValue) =>
    streamed((reporting, send) =>
      Stream.runForEach(elementsOf(run(payload, reporting)), (data) =>
        Effect.andThen(check(data), send({ event: "element", data }))
      )
    );
};

const progressedOf = ({ event, data }: Sent): Progressed => {
  if (event === "progress") {
    return Progressed.Progress({ value: data });
  }

  return event === "final"
    ? Progressed.Final({ value: data })
    : Progressed.Element({ value: data });
};

const answeredWithout = new Error(
  "A route of an action declaring progress or answering a stream answered without its event stream"
);

const sentFrom = (answer: ErasedValue): Stream.Stream<Progressed, unknown> =>
  Stream.isStream(answer)
    ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      Stream.map(answer as Stream.Stream<Sent, unknown>, progressedOf)
    : Stream.die(answeredWithout);

export const readWithProgress = (
  answer: ErasedValue,
  onProgress: CallOptions<unknown>["onProgress"]
): Effect.Effect<ErasedValue, unknown> =>
  answerFrom(sentFrom(answer), onProgress);

export const readElements = (
  answer: ErasedValue,
  onProgress: CallOptions<unknown>["onProgress"]
): Stream.Stream<ErasedValue, unknown> =>
  elementsFrom(sentFrom(answer), onProgress);
