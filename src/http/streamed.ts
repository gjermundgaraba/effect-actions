import { Cause, Effect, ErrorReporter, Queue, Schema, Stream } from "effect";
import { HttpServerRequest } from "effect/http";
import { HttpApiSchema } from "effect/http-api";
import type * as Action from "../contract/Action.js";
import { type ErasedHandler, type ErasedValue, elementsOf } from "../contract/implementation.js";
import {
  answerFrom,
  type CallOptions,
  elementsFrom,
  Progressed,
  type Reporting,
} from "../contract/progress.js";
import { concealed } from "../contract/reported.js";
import type { Codec } from "../contract/codec.js";
import type { StreamOf } from "../contract/stream.js";

/** One event a route streams: a progress value, an element, or the answer it ends with. */
interface Sent {
  readonly event: "progress" | "element" | "final";
  readonly data: ErasedValue;
}

const eventOf = <const N extends Sent["event"], D extends Codec>(event: N, data: D) =>
  Schema.Struct({
    id: Schema.optional(Schema.String),
    event: Schema.Literal(event),
    data: Schema.fromJsonString(Schema.toCodecJson(data)),
  });

type EventOf<N extends Sent["event"], D extends Codec> = ReturnType<typeof eventOf<N, D>>;

/** The success of the endpoint of action `A` declaring errors `E`, as `ActionHttp` builds it. */
export type SuccessOf<A extends Action.Any, E extends Schema.Top> =
  A["success"] extends StreamOf<infer Element>
    ? HttpApiSchema.StreamSse<
        Schema.Union<
          A["progress"] extends Codec
            ? readonly [EventOf<"element", Element>, EventOf<"progress", A["progress"]>]
            : readonly [EventOf<"element", Element>]
        >,
        E
      >
    : A["progress"] extends Codec
      ?
          | Schema.toCodecJson<A["success"]>
          | HttpApiSchema.StreamSse<
              Schema.Union<
                readonly [EventOf<"progress", A["progress"]>, EventOf<"final", A["success"]>]
              >,
              E
            >
      : Schema.toCodecJson<A["success"]>;

// Why: An empty answer is a 200 elsewhere, which a route cannot also stream at, so here it is a 204.
/** What a route of an action declaring `progress` answers without its stream: `success`. */
export const answeredWithProgress = (success: Action.Any["success"]) =>
  HttpApiSchema.isNoContent(success.ast) ? HttpApiSchema.NoContent : success;

/**
 * What a route of an action declaring `progress` answers a request accepting
 * `text/event-stream`: a `progress` event for each value its handler reports, then a `final`
 * event with its answer. A declared failure after the first event ends the stream as Effect's
 * stream failure event, and a defect as one saying `Internal server error`.
 */
export const progressStreamOf = (
  progress: Codec,
  success: Action.Any["success"],
  errors: ReadonlyArray<Schema.Top>,
) =>
  HttpApiSchema.StreamSse({
    events: Schema.Union([eventOf("progress", progress), eventOf("final", success)]),
    error: Schema.Union(errors),
  });

/**
 * What a route of an action answering a stream answers: an `element` event for each element,
 * beside a `progress` event for each value its handler reports where it declares `progress`. A
 * declared failure after the first event ends the stream as Effect's stream failure event, and
 * a defect as one saying `Internal server error`.
 */
export const elementStreamOf = (
  element: Codec,
  progress: Codec | undefined,
  errors: ReadonlyArray<Schema.Top>,
) =>
  HttpApiSchema.StreamSse({
    events: Schema.Union(
      progress === undefined
        ? [eventOf("element", element)]
        : [eventOf("element", element), eventOf("progress", progress)],
    ),
    error: Schema.Union(errors),
  });

// Why: The response waits for the call's first event, so a failure before it, a refusal included,
// answers with its own status, as without the stream, and is reported by the route. One after it
// ends the stream, so it is reported here, and each answer is checked against its schema here, as
// a stream's events are, since the surface's own encoder would send a defect's details. The call
// hands each event on one at a time, so a client reading slowly holds up the call, whose progress
// then drops the oldest values, and not the server's memory. A call ending before any event
// answers a stream of none.
const streamed = (
  progress: Codec | undefined,
  answer: (
    reporting: Reporting | undefined,
    send: (sent: Sent) => Effect.Effect<void>,
  ) => Effect.Effect<void, unknown, unknown>,
) =>
  Effect.gen(function* () {
    const sent = yield* Queue.bounded<Sent, unknown>(1);
    let streaming = false;

    const send = (event: Sent) =>
      Effect.andThen(
        Queue.offer(sent, event),
        Effect.sync(() => {
          streaming = true;
        }),
      );

    const reporting: Reporting | undefined =
      progress === undefined
        ? undefined
        : { progress: (data) => send({ event: "progress", data }) };

    const ended = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasDies(cause)) return concealed(cause);

      return streaming
        ? Effect.andThen(ErrorReporter.report(cause), Effect.failCause(cause))
        : Effect.failCause(cause);
    };

    yield* answer(reporting, send).pipe(
      Effect.catchCause(ended),
      Queue.into(sent),
      Effect.forkScoped({ startImmediately: true }),
    );

    const first = yield* Effect.catchIf(Queue.take(sent), Cause.isDone, () =>
      Effect.succeed(undefined),
    );

    return first === undefined
      ? Stream.empty
      : Stream.concat(Stream.make(first), Stream.fromQueue(sent));
  });

/** A check of `schema` failing as a defect, inside the call's boundary. */
const checkedBy = (schema: Codec) => {
  const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(schema));

  return (data: ErasedValue) => Effect.orDie(encode(data));
};

/**
 * The route handler of an action declaring `progress`: its answer streamed with its progress
 * where the request's `Accept` names `text/event-stream`, its answer alone otherwise.
 */
export const answeringWithProgress = (
  progress: Codec,
  success: Action.Any["success"],
  run: ErasedHandler<unknown>,
) => {
  const check = checkedBy(success);

  return (payload: ErasedValue) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      (request.headers.accept ?? "").includes("text/event-stream")
        ? streamed(progress, (reporting, send) =>
            run(payload, reporting).pipe(
              Effect.tap(check),
              Effect.flatMap((data) => send({ event: "final", data })),
            ),
          )
        : run(payload),
    );
};

/** The route handler of an action answering a stream: its elements and its progress, streamed. */
export const answeringElements = (
  element: Codec,
  progress: Codec | undefined,
  run: ErasedHandler<unknown>,
) => {
  const check = checkedBy(element);

  return (payload: ErasedValue) =>
    streamed(progress, (reporting, send) =>
      Stream.runForEach(elementsOf(run(payload, reporting)), (data) =>
        Effect.andThen(check(data), send({ event: "element", data })),
      ),
    );
};

const progressedOf = ({ event, data }: Sent): Progressed => {
  if (event === "progress") return Progressed.Progress({ value: data });

  return event === "final"
    ? Progressed.Final({ value: data })
    : Progressed.Element({ value: data });
};

// Why: Every request `ActionHttp.client` sends accepts an event stream, which such a route always
// answers with; only a server breaking the binding answers otherwise.
const answeredWithout = new Error(
  "A route of an action declaring progress or answering a stream answered without its event stream",
);

/** The events of a route's answer, as one stream of `Progressed`. */
const sentFrom = (answer: ErasedValue): Stream.Stream<Progressed, unknown> =>
  Stream.isStream(answer)
    ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Native API boundary: a route's stream schema decodes each element as one `Sent`.
      Stream.map(answer as Stream.Stream<Sent, unknown>, progressedOf)
    : Stream.die(answeredWithout);

/**
 * A client's answer from a route of an action declaring `progress`: each `progress` event handed
 * to `onProgress`, where the call gave one, then the `final` event's answer.
 */
export const readWithProgress = (
  answer: ErasedValue,
  onProgress: CallOptions<unknown>["onProgress"],
): Effect.Effect<ErasedValue, unknown> => answerFrom(sentFrom(answer), onProgress);

/**
 * A client's elements from a route of an action answering a stream: each `element` event's
 * data, each `progress` event's handed to `onProgress`.
 */
export const readElements = (
  answer: ErasedValue,
  onProgress: CallOptions<unknown>["onProgress"],
): Stream.Stream<ErasedValue, unknown> => elementsFrom(sentFrom(answer), onProgress);
