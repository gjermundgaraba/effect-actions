import { Effect, Predicate, Stream } from "effect";
import { HttpClientError } from "effect/http";
import * as Event from "../contract/Event.js";
import type { ErasedValue } from "../contract/implementation.js";
import { type Fed, fedOf, type Page } from "../contract/pages.js";
import type { AnySubscription, Pushed } from "../contract/push.js";
import {
  answeredStatus,
  failingWhenUnanswered,
  isTransient,
  receivedFrom,
} from "../contract/transient.js";
import { Receiving, webhookFed } from "../contract/receiving.js";
import type {
  AnyWebhookCancellation,
  AnyWebhookSubscription,
  Subscribed,
} from "../contract/subscribe.js";
import type { Transport, WebhookTransport } from "../contract/watch.js";

interface Subscription {
  readonly payload: AnySubscription;
}

/** The native client's method of one event's route, asked for a page. */
export type PollMethod<R> = (request: Subscription) => Effect.Effect<Page, unknown, R>;

/** The same method through a client asking for `text/event-stream`, which a server streams. */
export type StreamMethod<R> = (
  request: Subscription,
) => Effect.Effect<Page | Stream.Stream<Pushed, unknown>, unknown, R>;

const isNotFound = Predicate.compose(
  HttpClientError.isHttpClientError,
  (error) => answeredStatus(error) === 404,
);

/** The native client's methods of one event's webhook routes, where its binding has them. */
export interface WebhookMethods<R> {
  readonly subscribe: (request: {
    readonly payload: AnyWebhookSubscription;
  }) => Effect.Effect<Subscribed, unknown, R>;
  readonly unsubscribe: (request: {
    readonly payload: AnyWebhookCancellation;
  }) => Effect.Effect<void, unknown, R>;
}

/**
 * The transport of one subscription to `event` over its route, `input` its decoded input: each
 * page from `poll`, the stream from `stream`, and a webhook subscription from `webhook`'s routes
 * where the binding has them, a 404 failing as `NotServed`.
 */
export const transportOf = <R>(
  event: Event.Any,
  poll: PollMethod<R>,
  stream: StreamMethod<R>,
  webhook: WebhookMethods<R> | undefined,
  input: ErasedValue,
): Transport<unknown, R | Receiving> => {
  const notServed = Effect.fail(Event.SubscriptionError.of(event.name, new Event.NotServed()));

  const webhooks: WebhookTransport<unknown, R | Receiving> | undefined =
    webhook === undefined
      ? undefined
      : {
          receiver: Effect.service(Receiving),
          subscribe: (request) =>
            webhook.subscribe({ payload: { input, ...request } }).pipe(
              failingWhenUnanswered,
              Effect.catchIf(isNotFound, () => notServed),
            ),
          unsubscribe: (request) =>
            webhook.unsubscribe({ payload: { input, ...request } }).pipe(
              failingWhenUnanswered,
              Effect.catchIf(isNotFound, () => notServed),
            ),
          read: webhookFed(event),
        };

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
    webhook: webhooks,
    transient: isTransient,
  };
};
