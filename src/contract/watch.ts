import { Cause, Duration, Effect, Predicate, Schedule, Schema, Stream } from "effect";
import * as Event from "./Event.js";
import { type Fed, type Page, paged } from "./pages.js";
import { makeRecent } from "./recent.js";

/**
 * How a client reaches one subscription to the event `name`: a poll from a cursor and a stream
 * from one, each failing with `Unsupported` where its surface serves no such mode. Each answers
 * decoded occurrences. Where the stream crosses a network, `transient`
 * says which of its failures a reconnect may outlast.
 */
export interface Transport<E, R> {
  readonly name: string;
  readonly poll: (cursor: string | null) => Effect.Effect<Page, E, R>;
  readonly stream: (cursor: string | null) => Stream.Stream<Fed, E, R>;
  readonly transient?: ((error: E) => boolean) | undefined;
}

const reconnectDelay = Duration.seconds(1);

const maxReconnectDelay = Duration.seconds(30);

// Why: `Stream.retry` starts its schedule again at the first element after a failure, so the
// backoff counts only the failures since the stream last delivered.
const afterFailures = <E>(transient: (error: E) => boolean) =>
  Schedule.min([Schedule.exponential(reconnectDelay), Schedule.spaced(maxReconnectDelay)]).pipe(
    Schedule.setInputType<E>(),
    Schedule.while(({ input }) => transient(input)),
    Schedule.tap(({ input, duration }) =>
      Effect.logWarning(
        `A watch reconnects in ${Duration.format(duration)} after a failure`,
        input,
      ),
    ),
  );

const isSubscriptionError: Predicate.Refinement<unknown, Event.SubscriptionError> = Schema.is(
  Event.SubscriptionError,
);

/** Whether a watch's failure says the server serves its event by poll alone, refusing to push it. */
const pushRefused = Predicate.compose(
  isSubscriptionError,
  ({ reason }) =>
    Predicate.isTagged(reason, "Unsupported") &&
    reason.feature === "deliveryMode" &&
    reason.value === "push",
);

// Why: Duplicates arrive within a reconnect or a replay of the last page, so the ids of the last
// thousand occurrences are enough, and a long watch holds no more.
const dedupeWindow = 1000;

/**
 * The occurrences and gaps of one subscription, as every client's `watch` answers them. Each run
 * starts from `options`: what one run saw, the cursor and the ids it deduplicates by, ends with
 * it, and only `resume` carries a cursor to the next.
 */
export const watching = <E, R, SE>(
  transport: Transport<E, R>,
  { cursor: given, mode, resume }: Event.WatchOptions<SE> = {},
): Stream.Stream<Event.Received<Event.Any>, E | SE | Event.SubscriptionError, R> =>
  Stream.suspend(() => {
    const seen = makeRecent(dedupeWindow);
    let pending: string | null = null;

    const keep = (cursor: string | null): Effect.Effect<void, SE> =>
      cursor === null || resume === undefined ? Effect.void : resume.store.set(resume.key, cursor);

    const fresh = (eventId: string) => {
      if (seen.has(eventId)) return false;

      seen.add(eventId);

      return true;
    };

    // Why: A position is kept once what came before it is handled: an occurrence's when the next
    // element is pulled, which a consumer does after handling it, and a page's end as it is read,
    // after its occurrences. A consumer stopped mid-way then receives the unhandled one again.
    const handled = Effect.fnUntraced(function* (
      fed: Fed,
    ): Effect.fn.Return<ReadonlyArray<Event.Received<Event.Any>>, SE> {
      yield* keep(pending);
      pending = null;

      if (Predicate.isTagged(fed, "Checked")) {
        yield* keep(fed.cursor);

        return [];
      }

      if (Predicate.isTagged(fed, "Gap")) return [fed];

      pending = fed.cursor;

      return fresh(fed.eventId) ? [fed] : [];
    });

    const start: Effect.Effect<string | null, SE> =
      given !== undefined || resume === undefined
        ? Effect.succeed(given ?? null)
        : Effect.map(resume.store.get(resume.key), (kept) => kept ?? null);

    // Why: A subscription that ends or drops for a reason `transient` admits reopens from the last
    // position it reached, as long as the watch is read: a second after it ends, and after a
    // failure later each time, doubling to 30 seconds, until something arrives again. Each
    // reconnect is logged, and the watch's error channel keeps the failures it cannot outlast.
    // One that refuses to push, where `polled` is given, polls instead from that position.
    const reconnecting = (
      open: (cursor: string | null) => Stream.Stream<Fed, E, R>,
      cursor: string | null,
      polled?: (cursor: string | null) => Stream.Stream<Fed, E, R>,
    ): Stream.Stream<Fed, E, R> => {
      const { transient } = transport;
      let at = cursor;

      const once = Stream.suspend(() => open(at)).pipe(
        Stream.tap((fed) =>
          Effect.sync(() => {
            at = fed.cursor ?? at;
          }),
        ),
      );

      const reopened =
        transient === undefined
          ? once
          : once.pipe(
              Stream.repeat(Schedule.spaced(reconnectDelay)),
              Stream.retry(afterFailures(transient)),
            );

      return polled === undefined
        ? reopened
        : reopened.pipe(Stream.catchIf(pushRefused, () => Stream.suspend(() => polled(at))));
    };

    const polled = (cursor: string | null) =>
      reconnecting((at) => paged(transport.poll, at), cursor);

    return Stream.unwrap(
      Effect.map(start, (cursor) =>
        mode === "poll"
          ? polled(cursor)
          : reconnecting(transport.stream, cursor, mode === "stream" ? undefined : polled),
      ),
    ).pipe(
      Stream.rechunk(1),
      Stream.mapEffect(handled),
      // Why: A failure is pulled as the next element is, after the consumer handled the last.
      Stream.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Stream.failCause(cause)
          : Stream.concat(Stream.fromEffectDrain(keep(pending)), Stream.failCause(cause)),
      ),
      Stream.flattenIterable,
    );
  });

/**
 * The arguments of `watch(event, ...)` after the event: its input, which may be left out when
 * `{}` is a valid encoded input, as for an action's call, and the watch's options, whose `resume`
 * store may fail with `SE`.
 */
export type WatchArgs<E extends Event.Any, SE> = {} extends E["input"]["Encoded"]
  ? [input?: E["input"]["Type"], options?: Event.WatchOptions<SE>]
  : [input: E["input"]["Type"], options?: Event.WatchOptions<SE>];
