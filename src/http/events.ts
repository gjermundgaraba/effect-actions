import { Effect, type Option, Schema, Stream } from "effect";
import { HttpServerRequest } from "effect/http";
import { HttpApiEndpoint, HttpApiSchema, OpenApi } from "effect/http-api";
import type { Any as Authentication } from "../authentication/provider.js";
import { Refusal } from "../contract/errors.js";
import type * as Action from "../contract/Action.js";
import * as Event from "../contract/Event.js";
import { principalOf } from "../contract/caller.js";
import type { Feed } from "../contract/feed.js";
import { OccurrenceOf } from "../contract/occurrence.js";
import { type AnySubscription, PushedOf, queuedPush, SubscriptionOf } from "../contract/push.js";
import { assertDistinctTags } from "../contract/declared.js";
import { declared } from "../contract/status.js";
import {
  type AnyWebhookCancellation,
  type AnyWebhookSubscription,
  Subscribed,
  WebhookCancellationOf,
  WebhookSubscriptionOf,
} from "../contract/subscribe.js";
import { type Webhooks, webhookSubscriber } from "../contract/webhooks.js";

/**
 * One poll's answer: the occurrences since the cursor, and when to ask again, sent as
 * `nextPollMs`, its milliseconds.
 */
export const pageOf = <E extends Event.Any>(event: E) =>
  Schema.Struct({
    events: Schema.Array(OccurrenceOf(event)),
    cursor: Schema.NullOr(Schema.String),
    truncated: Schema.Boolean,
    hasMore: Schema.Boolean,
    nextPoll: Schema.DurationFromMillis,
  }).pipe(Schema.encodeKeys({ nextPoll: "nextPollMs" }));

/**
 * What a subscription's event stream sends, each as one SSE `message`: a `Checked` with the
 * position it starts from, or a `Gap` where that was no longer served, then each occurrence, a
 * `Gap` where some were missed, a `Checked` every 30 seconds, and a `Failed` where reading
 * failed and resumes. A later refusal ends it, as Effect's stream failure event.
 */
export const sentOf = <E extends Event.Any>(event: E) =>
  HttpApiSchema.StreamSse({ data: Schema.toCodecJson(PushedOf(event)), error: Refusal });

// Why: `answering` encodes each element as it queues it, inside the read's boundary, so the route
// `layer` serves sends that JSON as it is; the binding's own route, which clients and documents
// read, declares what it holds.
/** What a served subscription's event stream sends: each element's JSON, as `sentOf` encodes it. */
export const servedSent = HttpApiSchema.StreamSse({ data: Schema.Json, error: Refusal });

// Why: A POST, as an action's route, since a subscription's input is JSON and its credential a
// header; a browser's `EventSource` sends neither, so a browser watches with `fetchClient`.
/**
 * The route of one event type at `path`, its poll answered as JSON and its stream as SSE, as
 * `sent` declares it.
 */
export const eventEndpointOf = (
  event: Event.Any,
  path: `/${string}`,
  errors: Action.Errors,
  sent: ReturnType<typeof sentOf<Event.Any>> | typeof servedSent = sentOf(event),
) =>
  HttpApiEndpoint.post(event.name, path, {
    payload: SubscriptionOf(event).pipe(HttpApiSchema.asJson()),
    success: [pageOf(event), sent],
    error: errors.map(declared),
  }).annotate(OpenApi.Description, event.description);

/**
 * The webhook routes of one protected event type at `path`: `/subscribe`, which starts or
 * refreshes a subscription and answers its grant, and `/unsubscribe`, which ends it.
 */
export const webhookEndpointsOf = (event: Event.Any, path: `/${string}`, errors: Action.Errors) => {
  const withWebhooks = [...errors, Event.SubscriptionError];

  assertDistinctTags(`ActionHttp binding of event "${event.name}"'s webhook routes`, withWebhooks);

  const error = withWebhooks.map(declared);

  return [
    HttpApiEndpoint.post(`${event.name}/subscribe`, `${path}/subscribe`, {
      payload: WebhookSubscriptionOf(event).pipe(HttpApiSchema.asJson()),
      success: Subscribed,
      error,
    }).annotate(OpenApi.Description, `Deliver ${event.name} to a webhook, or refresh its grant.`),
    HttpApiEndpoint.post(`${event.name}/unsubscribe`, `${path}/unsubscribe`, {
      payload: WebhookCancellationOf(event).pipe(HttpApiSchema.asJson()),
      success: HttpApiSchema.NoContent,
      error,
    }).annotate(OpenApi.Description, `Stop delivering ${event.name} to a webhook.`),
  ] as const;
};

/**
 * The handlers of `feed`'s webhook routes, through `webhooks` where the host provided
 * `Webhook.layer`; without it, both fail with `Unsupported`.
 */
export const webhookAnswers = (
  feed: Feed,
  authentication: Authentication | undefined,
  webhooks: Option.Option<Webhooks["Service"]>,
) => {
  const served = webhookSubscriber(feed, authentication, webhooks);

  return {
    subscribe: ({ payload }: { readonly payload: AnyWebhookSubscription }) =>
      Effect.flatMap(served, ({ webhooks, ...subscriber }) =>
        webhooks.subscribe({ ...payload, ...subscriber }),
      ),
    unsubscribe: ({ payload }: { readonly payload: AnyWebhookCancellation }) =>
      Effect.flatMap(served, ({ webhooks, feed, principal }) =>
        webhooks.unsubscribe({ ...payload, feed, principal }),
      ),
  };
};

/**
 * Answers a subscription's request to `feed`: a page, or, where it accepts `text/event-stream`,
 * the subscription's stream, each element its JSON. Both admit the subscriber first, so a refusal
 * is the route's error; `authentication`'s principal names a poll's subscriber, for its
 * `subscription` hook.
 */
export const answering = (feed: Feed, authentication: Authentication | undefined) => {
  const encode = Schema.encodeEffect(Schema.toCodecJson(PushedOf(feed.event)));

  return ({ payload: { input, cursor } }: { readonly payload: AnySubscription }) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;

      if ((request.headers["accept"] ?? "").includes("text/event-stream")) {
        const open = yield* feed.stream(input);

        return Stream.fromQueue(yield* queuedPush(open, cursor, encode));
      }

      const subscriber = yield* principalOf(feed.event, authentication);

      return yield* feed.poll(input, cursor, { subscriber });
    });
};
