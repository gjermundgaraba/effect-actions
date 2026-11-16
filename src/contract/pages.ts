import { Duration, Effect, Option, Schema, Stream } from "effect";

import type * as Event from "./Event.js";
import { Checked, Gap, OccurrenceOf } from "./occurrence.js";

/** One poll's answer, as a surface sends it and a client reads it. */
export interface Page {
  readonly events: ReadonlyArray<Event.Occurrence<Event.Any>>;
  readonly cursor: string | null;
  readonly truncated: boolean;
  readonly hasMore: boolean;
  readonly nextPoll: Duration.Duration;
}

const pageFields = <O extends Schema.Top>(occurrence: O) => ({
  events: Schema.Array(occurrence),
  cursor: Schema.NullOr(Schema.String),
  truncated: Schema.Boolean,
  hasMore: Schema.Boolean,
  nextPoll: Schema.DurationFromMillis,
});

const nextPollKey = { nextPoll: "nextPollMs" } as const;

export const pageOf = <E extends Event.Any>(event: E) =>
  Schema.Struct(pageFields(OccurrenceOf(event))).pipe(
    Schema.encodeKeys(nextPollKey)
  );

const rpcPageWith = <O extends Schema.Top>(occurrence: O) =>
  Schema.Struct({ ...pageFields(occurrence), notified: Schema.Boolean }).pipe(
    Schema.encodeKeys(nextPollKey)
  );

export const rpcPageOf = <E extends Event.Any>(event: E) =>
  rpcPageWith(OccurrenceOf(event));

/**
 * The answer of an rpc's `<event>/poll`, `{ events, cursor, truncated, hasMore, nextPollMs,
 * notified }`, its occurrences left undecoded: an HTTP poll's page and `notified`. `hasMore` is
 * set when more are ready at once, `nextPollMs` is how long its client waits before it polls
 * again, and `notified` is `true` when the server learns of each change to the event's source as
 * it is made, an append to its log or a `notify`, so a host may hold a poll that found nothing
 * until one, and `false` when only reading the source again finds a change, as for a check source
 * not `notified` or an event `ActionEntity.reaching` reaches.
 */
export const AnyPage = rpcPageWith(Schema.Unknown);

/** What a feed's stream yields: what a subscriber receives, and where it has read up to. */
export type Fed = Event.Received<Event.Any> | Checked;

const pollFloor = Duration.seconds(1);

export interface Delivered {
  readonly items: ReadonlyArray<Event.Received<Event.Any>>;
  readonly truncated: boolean;
  readonly from: string | null;
  readonly to: string | null;
}

const gapSkippingNoneOf = ({ items, from, to }: Delivered) =>
  items.length === 0 ? to : from;

export const fedOf = (delivered: Delivered): readonly Fed[] => [
  ...(delivered.truncated
    ? [Gap.make({ cursor: gapSkippingNoneOf(delivered) })]
    : []),
  ...delivered.items,
  Checked.make({ cursor: delivered.to }),
];

export interface Paged extends Pick<Page, "cursor" | "hasMore" | "nextPoll"> {
  readonly fed: readonly Fed[];
}

export const pagedFrom = <E, R>(
  read: (cursor: string | null) => Effect.Effect<Paged, E, R>,
  cursor: string | null,
  woken?: Effect.Effect<void>,
  polls = true
): Stream.Stream<Fed, E, R> =>
  Stream.paginate({ cursor, delay: Duration.zero }, (state) => {
    const next = Effect.map(
      Effect.suspend(() => read(state.cursor)),
      (page) =>
        [
          page.fed,
          Option.some({
            cursor: page.cursor ?? state.cursor,
            delay: page.hasMore
              ? Duration.zero
              : Duration.max(page.nextPoll, pollFloor),
          }),
        ] as const
    );

    const sleep = Effect.sleep(state.delay);

    if (woken === undefined || Duration.isZero(state.delay)) {
      return Effect.andThen(sleep, next);
    }

    return Effect.andThen(polls ? Effect.race(sleep, woken) : woken, next);
  });

export const paged = <E, R>(
  poll: (cursor: string | null) => Effect.Effect<Page, E, R>,
  cursor: string | null
): Stream.Stream<Fed, E, R> =>
  pagedFrom(
    (at) =>
      Effect.map(poll(at), (page) => ({
        ...page,
        fed: fedOf({
          items: page.events,
          truncated: page.truncated,
          from: at,
          to: page.cursor ?? at,
        }),
      })),
    cursor
  );
