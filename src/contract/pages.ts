import { Duration, Effect, Option, Stream } from "effect";

import type * as Event from "./Event.js";
import { Checked, Gap } from "./occurrence.js";

/** One poll's answer, as a surface sends it and a client reads it. */
export interface Page {
  readonly events: ReadonlyArray<Event.Occurrence<Event.Any>>;
  readonly cursor: string | null;
  readonly truncated: boolean;
  readonly hasMore: boolean;
  readonly nextPoll: Duration.Duration;
}

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
