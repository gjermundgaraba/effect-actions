import { Effect, Predicate, Stream } from "effect";
import { HttpClientError } from "effect/http";

import * as Event from "../contract/Event.js";
import type { ErasedValue } from "../contract/implementation.js";
import { fedOf } from "../contract/pages.js";
import type { Fed, Page } from "../contract/pages.js";
import type { AnySubscription, Pushed } from "../contract/push.js";
import { Receiving, webhookFed } from "../contract/receiving.js";
import type {
  AnyWebhookCancellation,
  AnyWebhookSubscription,
  Subscribed,
} from "../contract/subscribe.js";
import {
  answeredStatus,
  failingWhenUnanswered,
  isTransient,
  receivedFrom,
} from "../contract/transient.js";
import type { Transport, WebhookTransport } from "../contract/watch.js";

interface Subscription {
  readonly payload: AnySubscription;
}

export type PollMethod<R> = (
  request: Subscription
) => Effect.Effect<Page, unknown, R>;

export type StreamMethod<R> = (
  request: Subscription
) => Effect.Effect<Page | Stream.Stream<Pushed, unknown>, unknown, R>;

export const isNotFound = Predicate.compose(
  HttpClientError.isHttpClientError,
  (error) => answeredStatus(error) === 404
);

export interface WebhookMethods<R> {
  readonly subscribe: (request: {
    readonly payload: AnyWebhookSubscription;
  }) => Effect.Effect<Subscribed, unknown, R>;
  readonly unsubscribe: (request: {
    readonly payload: AnyWebhookCancellation;
  }) => Effect.Effect<void, unknown, R>;
}

export const transportOf = <R>(
  event: Event.Any,
  poll: PollMethod<R>,
  stream: StreamMethod<R>,
  webhook: WebhookMethods<R> | undefined,
  input: ErasedValue
): Transport<unknown, R | Receiving> => {
  const notServed = Effect.fail(
    Event.SubscriptionError.of(event.name, new Event.NotServed())
  );

  const answered = <A, R2>(request: Effect.Effect<A, unknown, R2>) =>
    request.pipe(
      failingWhenUnanswered,
      Effect.catchIf(isNotFound, () => notServed)
    );

  const webhooks: WebhookTransport<unknown, R | Receiving> | undefined =
    webhook === undefined
      ? undefined
      : {
          receiver: Effect.service(Receiving),
          subscribe: (request) =>
            answered(webhook.subscribe({ payload: { input, ...request } })),
          unsubscribe: (request) =>
            answered(webhook.unsubscribe({ payload: { input, ...request } })),
          read: webhookFed(event),
        };

  const read = (
    sent: Stream.Stream<Pushed, unknown>
  ): Stream.Stream<Fed, unknown> =>
    sent.pipe(
      Stream.catchIf(Predicate.isTagged("Retry"), () => Stream.empty),
      receivedFrom("HTTP", event.name)
    );

  return {
    name: event.name,
    poll: (cursor) => answered(poll({ payload: { input, cursor } })),
    stream: (cursor) =>
      Stream.unwrap(
        answered(stream({ payload: { input, cursor } })).pipe(
          Effect.map((answer) =>
            Stream.isStream(answer)
              ? read(answer)
              : Stream.fromIterable(
                  fedOf({
                    items: answer.events,
                    truncated: answer.truncated,
                    from: cursor,
                    to: answer.cursor ?? cursor,
                  })
                )
          )
        )
      ),
    webhook: webhooks,
    transient: isTransient,
  };
};
