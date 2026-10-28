import {
  Cause,
  Duration,
  Effect,
  Latch,
  Match,
  Queue,
  Schema,
  Stream,
} from "effect";

import { Refusal } from "./errors.js";
import type * as Event from "./Event.js";
import { defaultNextPoll } from "./feed.js";
import { Checked, Gap, OccurrenceOf } from "./occurrence.js";
import type { Fed, Page } from "./pages.js";
import { reported } from "./reported.js";

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

export const SubscriptionOf = <E extends Event.Any>(event: E) =>
  subscriptionWith(event.input);

export const Subscription = subscriptionWith(Schema.Json);

export type AnySubscription = ReturnType<
  typeof SubscriptionOf<Event.Any>
>["Type"];

const queued = 16;

const heartbeatEvery = Duration.seconds(30);

const isFailed = Schema.is(Failed);

export const readOn =
  (surface: string, name: string) =>
  <E, R>(sent: Stream.Stream<Pushed, E, R>): Stream.Stream<Fed, E, R> =>
    sent.pipe(
      Stream.mapEffect((element): Effect.Effect<readonly Fed[]> =>
        isFailed(element)
          ? Effect.as(
              Effect.logWarning(
                `${surface} event "${name}" failed to read, and resumes`
              ),
              []
            )
          : Effect.succeed([element])
      ),
      Stream.flattenIterable
    );

const isRefused = Schema.is(Refusal);

export const refusalIn = (cause: Cause.Cause<unknown>): Refusal | undefined =>
  Cause.hasDies(cause)
    ? undefined
    : cause.reasons.flatMap((reason) =>
        Cause.isFailReason(reason) && isRefused(reason.error)
          ? [reason.error]
          : []
      )[0];

export const polledOn =
  (surface: string, name: string) =>
  <E, R>(poll: (cursor: string | null) => Effect.Effect<Page, E, R>) =>
  (cursor: string | null): Effect.Effect<Page, E, R> =>
    Effect.catchCauseIf(
      poll(cursor),
      (cause) =>
        !Cause.hasInterruptsOnly(cause) && refusalIn(cause) === undefined,
      (cause) =>
        Effect.as(
          Effect.andThen(
            reported(cause),
            Effect.logWarning(
              `${surface} event "${name}" failed to read, and resumes`
            )
          ),
          {
            events: [],
            cursor,
            truncated: false,
            hasMore: false,
            nextPoll: defaultNextPoll,
          }
        )
    );

/** How `pushed` treats a failure before its subscription is confirmed, and its positions. */
export interface PushOptions {
  /**
   * Read on through it, as through a later one: where the subscription's start was already
   * answered, as an HTTP stream's status is. Otherwise it ends the subscription.
   */
  readonly resumesUnconfirmed?: boolean | undefined;
  /**
   * Send each position the source reaches in order with its occurrences, and no heartbeat:
   * where a position sent is one every occurrence before it was delivered, as a webhook's
   * watermark is. Otherwise a heartbeat sends the position reached every 30 seconds.
   */
  readonly inOrder?: boolean | undefined;
}

export const pushed = <E, DE, R>(
  open: (cursor: string | null) => Stream.Stream<Fed, E, R>,
  cursor: string | null,
  deliver: (sent: Pushed) => Effect.Effect<void, DE>,
  { resumesUnconfirmed = false, inOrder = false }: PushOptions = {}
): Effect.Effect<void, E | DE, R> =>
  Effect.gen(function* () {
    const confirmed = yield* Latch.make();
    let reached = cursor;
    let active = false;
    let wait = Duration.zero;

    const movedTo = (at: string | null) =>
      Effect.suspend(() => {
        active = true;
        reached = at;

        return confirmed.open;
      });

    const sent = (element: Pushed, at: string | null) =>
      Effect.andThen(deliver(element), movedTo(at));

    const delivered = (fed: Fed): Effect.Effect<void, DE> =>
      Match.valueTags(fed, {
        Gap: (gap) => sent(gap, gap.cursor),
        Checked: (checked) => {
          if (!active) {
            return sent(checked, checked.cursor);
          }

          if (checked.cursor === null || checked.cursor === reached) {
            return Effect.void;
          }

          return inOrder
            ? sent(checked, checked.cursor)
            : movedTo(checked.cursor);
        },
        Occurrence: (occurrence) =>
          Effect.andThen(
            active
              ? Effect.void
              : sent(Checked.make({ cursor: reached }), reached),
            Effect.suspend(() => sent(occurrence, occurrence.cursor ?? reached))
          ),
      });

    const resumes = (cause: Cause.Cause<E | DE>) =>
      (active || resumesUnconfirmed) &&
      !Cause.hasInterruptsOnly(cause) &&
      refusalIn(cause) === undefined;

    const waiting = Effect.sync(() => {
      wait = defaultNextPoll;
    });

    const once = Stream.suspend(() =>
      Duration.isZero(wait)
        ? open(reached)
        : Stream.unwrap(Effect.as(Effect.sleep(wait), open(reached)))
    ).pipe(
      Stream.runForEach(delivered),
      Effect.catchCauseIf(resumes, (cause) =>
        Effect.andThen(reported(cause), deliver(Failed.make({})))
      ),
      Effect.andThen(waiting)
    );

    const heartbeat = Effect.andThen(
      confirmed.await,
      Effect.forever(
        Effect.andThen(Effect.sleep(heartbeatEvery), () =>
          Effect.suspend(() => deliver(Checked.make({ cursor: reached })))
        )
      )
    );

    return yield* inOrder
      ? Effect.forever(once)
      : Effect.raceFirst(Effect.forever(once), heartbeat);
  });

/** How `queuedPush` queues a subscription, beside `pushed`'s `inOrder`. */
export interface QueueOptions<E> extends Pick<PushOptions, "inOrder"> {
  /** Gives the failure that ends the subscription as the surface sends it. */
  readonly ending: <R>(
    run: Effect.Effect<void, unknown, R>
  ) => Effect.Effect<void, E, R>;
  /** How many elements wait for the reader; defaults to 16. */
  readonly capacity?: number | undefined;
}

export const queuedPush = <A, E>(
  open: (cursor: string | null) => Stream.Stream<Fed, unknown, unknown>,
  cursor: string | null,
  encode: (sent: Pushed) => Effect.Effect<A, unknown>,
  { ending, inOrder = false, capacity = queued }: QueueOptions<E>
) =>
  Effect.gen(function* () {
    const queue = yield* Queue.bounded<A, E | Cause.Done>(capacity);

    yield* pushed(
      open,
      cursor,
      (sent) =>
        Effect.flatMap(encode(sent), (element) => Queue.offer(queue, element)),
      { resumesUnconfirmed: true, inOrder }
    ).pipe(
      ending,
      Queue.into(queue),
      Effect.forkScoped({ startImmediately: true })
    );

    return queue;
  });
