import { Schema, Struct } from "effect";

import { CallbackUrl, WebhookSecret } from "./callback.js";
import * as Event from "./Event.js";
import { SubscriptionOf } from "./push.js";

export const WebhookCallback = Schema.Struct({
  url: CallbackUrl,
  secret: WebhookSecret,
});

export const WebhookTarget = WebhookCallback.mapFields(Struct.pick(["url"]));

export const webhookFields = {
  delivery: WebhookCallback,
  ttlMs: Schema.optional(Schema.NullOr(Schema.Finite)).annotate({
    description:
      "The lifetime it suggests, in milliseconds; the answer's refreshBefore is the grant.",
  }),
};

export const WebhookSubscriptionOf = <E extends Event.Any>(event: E) =>
  SubscriptionOf(event).pipe(Schema.fieldsAssign(webhookFields));

/** A webhook subscribe's request, its input decoded, as a surface reads it whatever its event. */
export type AnyWebhookSubscription = ReturnType<
  typeof WebhookSubscriptionOf<Event.Any>
>["Type"];

export const WebhookCancellationOf = <E extends Event.Any>(event: E) =>
  Schema.Struct({ input: event.input, delivery: WebhookTarget });

/** A webhook unsubscribe's request, its input decoded, whatever its event. */
export type AnyWebhookCancellation = ReturnType<
  typeof WebhookCancellationOf<Event.Any>
>["Type"];

/**
 * How a webhook subscription's deliveries are going, as a refresh answers it: whether it is
 * delivering, when it last delivered, and the category of its last failure, since when it fails.
 */
export const DeliveryStatus = Schema.Struct({
  active: Schema.Boolean,
  lastDeliveryAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Event.CallbackCategory),
  failedSince: Schema.optional(Schema.String),
});

export type DeliveryStatus = typeof DeliveryStatus.Type;

/**
 * A webhook subscription's grant: its id, which each delivery's `X-MCP-Subscription-Id` carries,
 * when to refresh it by, the position it is safe to resume from, and whether delivery starts
 * later than the cursor asked.
 */
export const Subscribed = Schema.Struct({
  id: Schema.String,
  refreshBefore: Schema.NullOr(Schema.String),
  cursor: Schema.NullOr(Schema.String),
  truncated: Schema.Boolean,
  deliveryStatus: Schema.optional(DeliveryStatus),
});

export type Subscribed = typeof Subscribed.Type;
