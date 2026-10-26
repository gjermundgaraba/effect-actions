import {
  Cause,
  Data,
  Effect,
  Exit,
  Fiber,
  Option,
  Queue,
  Schema,
  type Scope,
  Stream,
} from "effect";
import type { Codec } from "./codec.js";
import type { ErasedValue } from "./implementation.js";

/** Where a call's progress goes: each value reported, checked by its schema, is given to `progress`. */
export interface Reporting {
  readonly progress: (value: ErasedValue) => Effect.Effect<void>;
}

/** The second argument of a handler of `A`, where `A` declares `progress`: what it reports by. */
export type ReportingOf<A extends { readonly progress: Codec | undefined }> =
  A["progress"] extends undefined
    ? []
    : [
        reporting: {
          /** Reports `value` to the caller, never waiting for it: see `Action.Options.progress`. */
          readonly progress: (value: NonNullable<A["progress"]>["Type"]) => Effect.Effect<void>;
        },
      ];

/** What a call of an action reporting progress `P` takes after its input. */
export interface CallOptions<P> {
  /**
   * Run with each progress value the handler reports, in order, before the call answers; which
   * values reach it, and what its failure does, are on `Action.Options.progress`.
   */
  readonly onProgress?: ((progress: P) => Effect.Effect<void>) | undefined;
}

/** What a call of `A` takes after its input, where `A` declares `progress`. */
export type ProgressArgs<A extends { readonly progress: Codec | undefined }> =
  A["progress"] extends undefined
    ? []
    : [options?: CallOptions<NonNullable<A["progress"]>["Type"]>];

// Why: A handler reporting faster than its caller reads keeps only the latest values, so a slow
// caller holds up neither the handler nor its memory.
const capacity = 16;

interface Buffered {
  readonly reporting: Reporting;
  /** Hands on what is still buffered, then ends: what a call runs before its answer. */
  readonly drained: Effect.Effect<void>;
}

/**
 * What a handler reports by, where `progress` is declared: each value checked by the schema, one
 * breaking it a defect, and handed to `sink` from a buffer dropping the oldest, so the handler
 * never waits. Without a `sink`, values are checked and dropped.
 */
const buffering = (
  progress: Codec,
  sink: Reporting | undefined,
): Effect.Effect<Buffered, never, Scope.Scope> => {
  const check = Schema.decodeUnknownEffect(Schema.toType(progress));
  const checked = (value: ErasedValue) => Effect.orDie(check(value));

  if (sink === undefined)
    return Effect.succeed({
      reporting: { progress: (value) => Effect.asVoid(checked(value)) },
      drained: Effect.void,
    });

  return Effect.gen(function* () {
    const buffered = yield* Queue.sliding<unknown, Cause.Done>(capacity);

    const forwarding = yield* Effect.forkScoped(
      Stream.runForEach(Stream.fromQueue(buffered), sink.progress),
    );

    return {
      reporting: {
        progress: (value) =>
          Effect.flatMap(checked(value), (each) => Effect.asVoid(Queue.offer(buffered, each))),
      },
      drained: Effect.andThen(Queue.end(buffered), Fiber.join(forwarding)),
    };
  });
};

/** Whether what is buffered still reaches the caller after `cause` ends a call. */
const drainsAfter = (cause: Cause.Cause<unknown>) => !Cause.hasInterruptsOnly(cause);

/**
 * Runs `handle` with what it reports by, as `buffering` makes it; what is buffered when it
 * succeeds or fails reaches `sink` before its answer.
 */
export const reportedTo = <A, E, R>(
  progress: Codec | undefined,
  sink: Reporting | undefined,
  handle: (reporting: Reporting | undefined) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | Scope.Scope> => {
  if (progress === undefined) return handle(undefined);

  return Effect.gen(function* () {
    const { reporting, drained } = yield* buffering(progress, sink);
    const exit = yield* Effect.exit(handle(reporting));

    if (Exit.isSuccess(exit) || drainsAfter(exit.cause)) yield* drained;

    return yield* exit;
  });
};

/**
 * Runs the stream `handle` gives with what it reports by, as `buffering` makes it, in the
 * stream's scope; what is buffered when it ends or fails reaches `sink` before its end.
 */
export const streamReportedTo = <A, E, R>(
  progress: Codec | undefined,
  sink: Reporting | undefined,
  handle: (reporting: Reporting | undefined) => Stream.Stream<A, E, R>,
): Stream.Stream<A, E, R> => {
  if (progress === undefined) return handle(undefined);

  return Stream.unwrap(
    Effect.map(buffering(progress, sink), ({ reporting, drained }) =>
      handle(reporting).pipe(
        Stream.onEnd(drained),
        Stream.catchCause((cause) =>
          drainsAfter(cause)
            ? Stream.unwrap(Effect.as(drained, Stream.failCause(cause)))
            : Stream.failCause(cause),
        ),
      ),
    ),
  );
};

// Why: `onProgress` shows a value, so its failure, a defect or a throw included, is logged and the
// call goes on: a call whose handler answered never reads as failed, nor is its handler
// interrupted, on every surface alike.
const shown =
  (onProgress: NonNullable<CallOptions<unknown>["onProgress"]>) =>
  (value: ErasedValue): Effect.Effect<void> =>
    Effect.catchCause(
      Effect.suspend(() => onProgress(value)),
      (cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("onProgress failed", cause),
    );

/** What a caller in process hands a call for `onProgress`, as `Action.client` and the toolkit do. */
export const progressSink = (
  onProgress: CallOptions<unknown>["onProgress"],
): Reporting | undefined =>
  onProgress === undefined ? undefined : { progress: shown(onProgress) };

/**
 * One element a call streams: a value reported, the answer of an action answering one value, or
 * an element of one answering a stream.
 */
export type Progressed = Data.TaggedEnum<{
  readonly Progress: { readonly value: ErasedValue };
  readonly Final: { readonly value: ErasedValue };
  readonly Element: { readonly value: ErasedValue };
}>;

export const Progressed = Data.taggedEnum<Progressed>();

const endedEarly = Effect.die(
  new Error("An answer streamed with its progress ended without its final element"),
);

/**
 * A client's answer from a call's `stream`: each `Progress` value handed to `onProgress`, where
 * the call gave one, then the `Final` value. A stream ending without one is a defect.
 */
export const answerFrom = <E, R>(
  stream: Stream.Stream<Progressed, E, R>,
  onProgress: CallOptions<unknown>["onProgress"],
): Effect.Effect<unknown, E, R> => {
  const report = progressSink(onProgress)?.progress ?? (() => Effect.void);

  return Effect.flatMap(
    Stream.runFoldEffect(
      stream,
      () => Option.none<unknown>(),
      (final, element) =>
        Progressed.$is("Final")(element)
          ? Effect.succeed(Option.some(element.value))
          : Effect.as(report(element.value), final),
    ),
    Option.match({ onNone: () => endedEarly, onSome: Effect.succeed }),
  );
};

/**
 * A client's elements from a call's `stream` of an action answering a stream: each `Progress`
 * value handed to `onProgress`, where the call gave one, and each `Element` value streamed.
 */
export const elementsFrom = <E, R>(
  stream: Stream.Stream<Progressed, E, R>,
  onProgress: CallOptions<unknown>["onProgress"],
): Stream.Stream<unknown, E, R> => {
  const report = progressSink(onProgress)?.progress ?? (() => Effect.void);

  return Stream.flatMap(stream, (sent) =>
    Progressed.$is("Progress")(sent)
      ? Stream.fromEffectDrain(report(sent.value))
      : Stream.make(sent.value),
  );
};
