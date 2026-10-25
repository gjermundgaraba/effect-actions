import { Duration, Effect, Predicate, Stream } from "effect";
import { HttpClientError } from "effect/http";
import * as Event from "../contract/Event.js";
import type { ErasedValue } from "../contract/implementation.js";
import { type Fed, fedOf, type Page } from "../contract/pages.js";
import type { Pushed } from "../contract/push.js";
import {
  answeredStatus,
  failingWhenUnanswered,
  isTransient,
  receivedFrom,
} from "../contract/transient.js";
import type { Transport } from "../contract/watch.js";

/** One poll's answer as the native client decodes it, its wait in milliseconds. */
export interface WirePage extends Omit<Page, "nextPoll"> {
  readonly nextPollMs: number;
}

interface Subscription {
  readonly payload: { readonly input: ErasedValue; readonly cursor: string | null };
}

/** The native client's method of one event's route, asked for a page. */
export type PollMethod<R> = (request: Subscription) => Effect.Effect<WirePage, unknown, R>;

/** The same method through a client asking for `text/event-stream`, which a server streams. */
export type StreamMethod<R> = (
  request: Subscription,
) => Effect.Effect<WirePage | Stream.Stream<Pushed, unknown>, unknown, R>;

const isNotFound = Predicate.compose(
  HttpClientError.isHttpClientError,
  (error) => answeredStatus(error) === 404,
);

/**
 * The transport of one subscription to `event` over its route, `input` its decoded input: each
 * page from `poll` and the stream from `stream`, a 404 failing as `NotServed`.
 */
export const transportOf = <R>(
  event: Event.Any,
  poll: PollMethod<R>,
  stream: StreamMethod<R>,
  input: ErasedValue,
): Transport<unknown, R> => {
  const notServed = Effect.fail(Event.SubscriptionError.of(event.name, new Event.NotServed()));

  const read = (sent: Stream.Stream<Pushed, unknown>): Stream.Stream<Fed, unknown> =>
    sent.pipe(
      // Why: The native client's decoder ends the stream at a `retry:` field, with no way to skip
      // it, so the stream ends there and the watch connects again a second later, as at any end;
      // `ActionHttp.layer` sends none.
      Stream.catchIf(Predicate.isTagged("Retry"), () => Stream.empty),
      receivedFrom("HTTP", event.name),
    );

  return {
    name: event.name,
    poll: (cursor) =>
      poll({ payload: { input, cursor } }).pipe(
        failingWhenUnanswered,
        Effect.catchIf(isNotFound, () => notServed),
        Effect.map(({ nextPollMs, ...page }) => ({
          ...page,
          nextPoll: Duration.millis(nextPollMs),
        })),
      ),
    // Why: A page answering a stream's request, from a proxy dropping its `Accept`, is read as a
    // stream that ends, so the watch asks again a second later.
    stream: (cursor) =>
      Stream.unwrap(
        stream({ payload: { input, cursor } }).pipe(
          failingWhenUnanswered,
          Effect.catchIf(isNotFound, () => notServed),
          Effect.map((answer) =>
            Stream.isStream(answer)
              ? read(answer)
              : Stream.fromIterable(
                  fedOf({
                    items: answer.events,
                    truncated: answer.truncated,
                    from: cursor,
                    to: answer.cursor ?? cursor,
                  }),
                ),
          ),
        ),
      ),
    transient: isTransient,
  };
};
