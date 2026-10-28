import { Effect, Function, Schema, Stream } from "effect";
import type { Option } from "effect";
import { HttpServerRequest } from "effect/http";
import { HttpApiEndpoint, HttpApiSchema, OpenApi } from "effect/http-api";

import type { Any as Authentication } from "../authentication/provider.js";
import type * as Action from "../contract/Action.js";
import { principalOf } from "../contract/caller.js";
import { assertDistinctTags } from "../contract/declared.js";
import { Refusal } from "../contract/errors.js";
import * as Event from "../contract/Event.js";
import type { Feed } from "../contract/feed.js";
import { OccurrenceOf } from "../contract/occurrence.js";
import { PushedOf, queuedPush, SubscriptionOf } from "../contract/push.js";
import type { AnySubscription } from "../contract/push.js";
import { declared } from "../contract/status.js";
import {
  Subscribed,
  WebhookCancellationOf,
  WebhookSubscriptionOf,
} from "../contract/subscribe.js";
import type {
  AnyWebhookCancellation,
  AnyWebhookSubscription,
} from "../contract/subscribe.js";
import { webhookSubscriber } from "../contract/webhooks.js";
import type { Webhooks } from "../contract/webhooks.js";

export const pageOf = <E extends Event.Any>(event: E) =>
  Schema.Struct({
    events: Schema.Array(OccurrenceOf(event)),
    cursor: Schema.NullOr(Schema.String),
    truncated: Schema.Boolean,
    hasMore: Schema.Boolean,
    nextPoll: Schema.DurationFromMillis,
  }).pipe(Schema.encodeKeys({ nextPoll: "nextPollMs" }));

export const sentOf = <E extends Event.Any>(event: E) =>
  HttpApiSchema.StreamSse({
    data: Schema.toCodecJson(PushedOf(event)),
    error: Refusal,
  });

export const servedSent = HttpApiSchema.StreamSse({
  data: Schema.Json,
  error: Refusal,
});

export const eventEndpointOf = (
  event: Event.Any,
  path: `/${string}`,
  errors: Action.Errors,
  sent: ReturnType<typeof sentOf<Event.Any>> | typeof servedSent = sentOf(event)
) =>
  HttpApiEndpoint.post(event.name, path, {
    payload: SubscriptionOf(event).pipe(HttpApiSchema.asJson()),
    success: [pageOf(event), sent],
    error: errors.map(declared),
  }).annotate(OpenApi.Description, event.description);

export const webhookEndpointsOf = (
  event: Event.Any,
  path: `/${string}`,
  errors: Action.Errors
) => {
  const withWebhooks = [...errors, Event.SubscriptionError];

  assertDistinctTags(
    `ActionHttp binding of event "${event.name}"'s webhook routes`,
    withWebhooks
  );

  const error = withWebhooks.map(declared);

  return [
    HttpApiEndpoint.post(`${event.name}/subscribe`, `${path}/subscribe`, {
      payload: WebhookSubscriptionOf(event).pipe(HttpApiSchema.asJson()),
      success: Subscribed,
      error,
    }).annotate(
      OpenApi.Description,
      `Deliver ${event.name} to a webhook, or refresh its grant.`
    ),
    HttpApiEndpoint.post(`${event.name}/unsubscribe`, `${path}/unsubscribe`, {
      payload: WebhookCancellationOf(event).pipe(HttpApiSchema.asJson()),
      success: HttpApiSchema.NoContent,
      error,
    }).annotate(
      OpenApi.Description,
      `Stop delivering ${event.name} to a webhook.`
    ),
  ] as const;
};

export const webhookAnswers = (
  feed: Feed,
  authentication: Authentication | undefined,
  webhooks: Option.Option<Webhooks["Service"]>
) => {
  const served = webhookSubscriber(feed, authentication, webhooks);

  return {
    subscribe: ({ payload }: { readonly payload: AnyWebhookSubscription }) =>
      Effect.flatMap(served, ({ webhooks: service, ...subscriber }) =>
        service.subscribe({ ...payload, ...subscriber })
      ),
    unsubscribe: ({ payload }: { readonly payload: AnyWebhookCancellation }) =>
      Effect.flatMap(
        served,
        ({ webhooks: service, feed: subscribed, principal }) =>
          service.unsubscribe({ ...payload, feed: subscribed, principal })
      ),
  };
};

export const answering = (
  feed: Feed,
  authentication: Authentication | undefined
) => {
  const encode = Schema.encodeEffect(Schema.toCodecJson(PushedOf(feed.event)));

  return ({
    payload: { input, cursor },
  }: {
    readonly payload: AnySubscription;
  }) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;

      if ((request.headers["accept"] ?? "").includes("text/event-stream")) {
        const open = yield* feed.stream(input);

        return Stream.fromQueue(
          yield* queuedPush(open, cursor, encode, { ending: Function.identity })
        );
      }

      const subscriber = yield* principalOf(feed.event, authentication);

      return yield* feed.poll(input, cursor, { subscriber });
    });
};
