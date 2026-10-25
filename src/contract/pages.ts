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

/** The shortest wait between polls, whatever a source or a server asks for. */
const pollFloor = Duration.seconds(1);

/**
 * One page as a feed yields it, read from `cursor`: its gap, at `cursor` where the page holds
 * occurrences, so that a resume from it never skips them, and at its end where it holds none,
 * then those occurrences, and where it ends.
 */
export const fedOf = (
  page: Pick<Page, "events" | "cursor" | "truncated">,
  cursor: string | null,
): ReadonlyArray<Fed> => [
  ...(page.truncated
    ? [Gap.make({ cursor: page.events.length === 0 ? (page.cursor ?? cursor) : cursor })]
    : []),
  ...page.events,
  Checked.make({ cursor: page.cursor ?? cursor }),
];

/** One page as a feed's stream reads it: what the stream yields of it, and when to read on. */
export interface Paged extends Pick<Page, "cursor" | "hasMore" | "nextPoll"> {
  readonly fed: ReadonlyArray<Fed>;
}

/**
 * Reads from `cursor` again and again, as long as the stream is read: what each page yields, then
 * a wait of its `nextPoll`, at least `pollFloor`, cut short by `woken`, or none where it has more;
 * where `polls` is `false`, a wait for `woken` alone.
 */
export const pagedFrom = <E, R>(
  read: (cursor: string | null) => Effect.Effect<Paged, E, R>,
  cursor: string | null,
  woken?: Effect.Effect<void>,
  polls = true,
): Stream.Stream<Fed, E, R> =>
  Stream.paginate({ cursor, delay: Duration.zero }, (state) =>
    Effect.map(
      Effect.andThen(
        woken === undefined || Duration.isZero(state.delay)
          ? Effect.sleep(state.delay)
          : polls
            ? Effect.race(Effect.sleep(state.delay), woken)
            : woken,
        Effect.suspend(() => read(state.cursor)),
      ),
      (page) =>
        [
          page.fed,
          Option.some({
            cursor: page.cursor ?? state.cursor,
            delay: page.hasMore ? Duration.zero : Duration.max(page.nextPoll, pollFloor),
          }),
        ] as const,
    ),
  );

/** Polls from `cursor` as `pagedFrom` reads: each page as its gap, its occurrences, its end. */
export const paged = <E, R>(
  poll: (cursor: string | null) => Effect.Effect<Page, E, R>,
  cursor: string | null,
): Stream.Stream<Fed, E, R> =>
  pagedFrom((at) => Effect.map(poll(at), (page) => ({ ...page, fed: fedOf(page, at) })), cursor);
