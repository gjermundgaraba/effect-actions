import { Cause, Duration, Effect, Latch, Match, Queue, Schema, Stream } from "effect";
import { reported } from "./reported.js";
import { Refusal } from "./errors.js";
import { defaultNextPoll } from "./feed.js";
import { Checked, Gap, OccurrenceOf } from "./occurrence.js";
import type { Fed, Page } from "./pages.js";
import type * as Event from "./Event.js";

/**
 * A push subscription read on through a failure no refusal explains, such as an upstream's
 * outage: its cause is logged and reported, and reading resumes from the position reached.
 */
export const Failed = Schema.TaggedStruct("Failed", {});

export type Failed = typeof Failed.Type;

/**
 * What a push subscription sends: first a `Checked`, or a `Gap` where the position it starts
 * from was no longer served, confirming it; then each occurrence, a `Gap` where some were
 * missed, a `Checked` with the position reached every 30 seconds, and a `Failed` where reading
 * failed and resumes.
 */
export type Pushed = Event.Occurrence<Event.Any> | Gap | Checked | Failed;

/** What a push subscription of `event` sends, as each surface's stream encodes it. */
export const PushedOf = <E extends Event.Any>(event: E) =>
  Schema.Union([OccurrenceOf(event), Gap, Checked, Failed]);

const subscriptionWith = <I extends Schema.Top>(input: I) =>
  Schema.Struct({
    input,
    cursor: Schema.NullOr(Schema.String)
      .annotate({
        description:
          "Where to resume: a cursor an occurrence or a page carried; null or omitted, from now.",
      })
      .pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  });

/**
 * What a subscription's request carries: the event's input, and the cursor it resumes from,
 * `null` where it is omitted.
 */
export const SubscriptionOf = <E extends Event.Any>(event: E) => subscriptionWith(event.input);

// Why: A surface decoding the envelope apart from the event's input reports an `InvalidInput`
// whose issue paths are relative to the input, as an action call's are.
/** A subscription's request, its input left as JSON for its event's schema to decode. */
export const Subscription = subscriptionWith(Schema.Json);

/** A subscription's request, its input decoded, as a surface reads it whatever its event. */
export type AnySubscription = ReturnType<typeof SubscriptionOf<Event.Any>>["Type"];

// Why: A few elements, so a reader slower than the feed stalls its read: a log source's
// subscriber then falls behind its log into a `Gap`, rather than a surface's queue growing.
const queued = 16;

const heartbeatEvery = Duration.seconds(30);

const isFailed = Schema.is(Failed);

/** Each element of a push stream of `surface`'s event `name` but `Failed`, which is logged. */
export const readOn =
  (surface: string, name: string) =>
  <E, R>(sent: Stream.Stream<Pushed, E, R>): Stream.Stream<Fed, E, R> =>
    sent.pipe(
      Stream.mapEffect((element): Effect.Effect<ReadonlyArray<Fed>> =>
        isFailed(element)
          ? Effect.as(
              Effect.logWarning(`${surface} event "${name}" failed to read, and resumes`),
              [],
            )
          : Effect.succeed([element]),
      ),
      Stream.flattenIterable,
    );

/**
 * A poll of `name` that answers a failure no refusal explains, reported, as a page of none from
 * the cursor asked, read again after the poll interval: where no network carries a 500 for a
 * client to retry, as in process, it reads on as `pushed` does.
 */
export const polledOn =
  (surface: string, name: string) =>
  <E, R>(poll: (cursor: string | null) => Effect.Effect<Page, E, R>) =>
  (cursor: string | null): Effect.Effect<Page, E, R> =>
    Effect.catchCause(poll(cursor), (cause) =>
      Cause.hasInterruptsOnly(cause) || refusalIn(cause) !== undefined
        ? Effect.failCause(cause)
        : Effect.as(
            Effect.andThen(
              reported(cause),
              Effect.logWarning(`${surface} event "${name}" failed to read, and resumes`),
            ),
            { events: [], cursor, truncated: false, hasMore: false, nextPoll: defaultNextPoll },
          ),
    );

const isRefused = Schema.is(Refusal);

/** The refusal that `cause` fails with, unless it also holds a defect. */
export const refusalIn = (cause: Cause.Cause<unknown>): Refusal | undefined =>
  Cause.hasDies(cause)
    ? undefined
    : cause.reasons.flatMap((reason) =>
        Cause.isFailReason(reason) && isRefused(reason.error) ? [reason.error] : [],
      )[0];

/** How `pushed` treats a failure before its subscription is confirmed, and its positions. */
export interface PushOptions {
  /**
   * Read on through it, as through a later one: where the subscription's start was already
   * answered, as an HTTP stream's status is. Otherwise it ends the subscription.
   */
  readonly resumesUnconfirmed?: boolean | undefined;
  /**
   * Send each position the source reaches in order with its occurrences, and no heartbeat:
   * where a position sent is one every occurrence before it was delivered. Otherwise a heartbeat sends the position reached every 30 seconds.
   */
  readonly inOrder?: boolean | undefined;
}

/**
 * One push subscription of a feed `open` reads from a cursor, starting at `cursor`, each thing it
 * sends given to `deliver`. A refusal, an interruption, or, unless `resumesUnconfirmed`, a failure
 * before it is confirmed ends it; any other failure of a read or of its delivery is reported,
 * sent as `Failed`, and reading resumes from the position delivered after the poll interval.
 */
export const pushed = <R>(
  open: (cursor: string | null) => Stream.Stream<Fed, unknown, R>,
  cursor: string | null,
  deliver: (sent: Pushed) => Effect.Effect<void, unknown>,
  { resumesUnconfirmed = false, inOrder = false }: PushOptions = {},
): Effect.Effect<void, unknown, R> =>
  Effect.gen(function* () {
    const confirmed = yield* Latch.make();
    let reached = cursor;
    let active = false;
    let wait = Duration.zero;

    // Why: The position moves once what precedes it is delivered, so the heartbeat never sends
    // one past an occurrence still on its way, and a failure to deliver resumes before it.
    const movedTo = (at: string | null) =>
      Effect.suspend(() => {
        active = true;
        reached = at;

        return confirmed.open;
      });

    const sent = (pushed: Pushed, at: string | null) =>
      Effect.andThen(deliver(pushed), movedTo(at));

    // Why: A source's own `Checked`, such as a quiet page every few seconds, only moves the
    // position once the subscription is confirmed: the heartbeat sends it, at its own pace.
    const delivered = (fed: Fed): Effect.Effect<void, unknown> =>
      Match.valueTags(fed, {
        Gap: (gap) => sent(gap, gap.cursor),
        Checked: (checked) =>
          !active
            ? sent(checked, checked.cursor)
            : checked.cursor === null || checked.cursor === reached
              ? Effect.void
              : inOrder
                ? sent(checked, checked.cursor)
                : movedTo(checked.cursor),
        Occurrence: (occurrence) =>
          Effect.andThen(
            active ? Effect.void : sent(Checked.make({ cursor: reached }), reached),
            Effect.suspend(() => sent(occurrence, occurrence.cursor ?? reached)),
          ),
      });

    const resumes = (cause: Cause.Cause<unknown>) =>
      (active || resumesUnconfirmed) &&
      !Cause.hasInterruptsOnly(cause) &&
      refusalIn(cause) === undefined;

    const waiting = Effect.sync(() => {
      wait = defaultNextPoll;
    });

    // Why: Delivery runs inside the read's boundary, so a failure to deliver is reported and
    // resumed from as a source's is. An occurrence breaking its schema never reaches it: the feed
    // reports it and sends a `Gap` in its place.
    const once = Stream.suspend(() =>
      Duration.isZero(wait)
        ? open(reached)
        : Stream.unwrap(Effect.as(Effect.sleep(wait), open(reached))),
    ).pipe(
      Stream.runForEach(delivered),
      Effect.catchCause((cause) =>
        resumes(cause)
          ? Effect.andThen(reported(cause), deliver(Failed.make({})))
          : Effect.failCause(cause),
      ),
      Effect.andThen(waiting),
    );

    const heartbeat = Effect.andThen(
      confirmed.await,
      Effect.forever(
        Effect.andThen(Effect.sleep(heartbeatEvery), () =>
          Effect.suspend(() => deliver(Checked.make({ cursor: reached }))),
        ),
      ),
    );

    // Why: The feed is read in the subscriber's own fiber, from the moment the subscription
    // starts, so its first position is the subscription's start.
    return yield* inOrder
      ? Effect.forever(once)
      : Effect.raceFirst(Effect.forever(once), heartbeat);
  });

/** How `queuedPush` queues a subscription, beside `pushed`'s `inOrder`. */
export interface QueueOptions extends Pick<PushOptions, "inOrder"> {
  /** Gives the failure that ends the subscription as the surface sends it. */
  readonly ending?:
    | (<R>(run: Effect.Effect<void, unknown, R>) => Effect.Effect<void, unknown, R>)
    | undefined;
  /** How many elements wait for the reader; defaults to 16. */
  readonly capacity?: number | undefined;
}

// Why: Started at once in the request's scope, which the surface closes as its response ends, so
// a watch from now starts where it asked. The response's status is sent before the
// first read, so a failure before the subscription is confirmed resumes as a later one does, as a
// poll's 500 is retried; each element is encoded before it is queued, inside the read's boundary,
// so the surface's own encoder, which would send a defect's details, never fails.
/**
 * A push subscription for a surface's streamed response: read into a bounded queue, each element
 * as `encode` gives it, forked in the current scope.
 */
export const queuedPush = <A>(
  open: (cursor: string | null) => Stream.Stream<Fed, unknown, unknown>,
  cursor: string | null,
  encode: (sent: Pushed) => Effect.Effect<A, unknown>,
  { ending = (run) => run, inOrder = false, capacity = queued }: QueueOptions = {},
) =>
  Effect.gen(function* () {
    const queue = yield* Queue.bounded<A, unknown>(capacity);

    yield* pushed(
      open,
      cursor,
      (sent) => Effect.flatMap(encode(sent), (element) => Queue.offer(queue, element)),
      { resumesUnconfirmed: true, inOrder },
    ).pipe(ending, Queue.into(queue), Effect.forkScoped({ startImmediately: true }));

    return queue;
  });
