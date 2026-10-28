import { ErrorReporter, Schema, Struct } from "effect";
import { McpSchema } from "effect/ai";
import { Rpc, RpcGroup } from "effect/rpc";

import { eventCodes } from "../contract/codes.js";
import {
  Subscribed,
  WebhookCallback,
  webhookFields,
  WebhookTarget,
} from "../contract/subscribe.js";

export const extension = "io.modelcontextprotocol/events";

export const subscriptionIdKey = "io.modelcontextprotocol/subscriptionId";

export const codes = {
  headerMismatch: -32_020,
  ...eventCodes,
  invalidParams: -32_602,
  internal: -32_603,
} as const;

const Meta = Schema.optional(Schema.Record(Schema.String, Schema.Json));

const Arguments = Schema.optional(Schema.Record(Schema.String, Schema.Json));

const Cursor = Schema.optional(Schema.NullOr(Schema.String));

export const WireError = Schema.Struct({
  code: Schema.Int,
  message: Schema.String,
  data: Schema.optional(Schema.Json),
});

export type WireError = typeof WireError.Type;

export class EventsError extends Schema.Error<
  EventsError,
  { readonly brand: unique symbol }
>("effect-actions/McpEventsError")(WireError.fields) {
  override readonly [ErrorReporter.ignore] = true;
}

export const EventDescriptor = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  delivery: Schema.Array(Schema.Literals(["poll", "push", "webhook"])),
  inputSchema: McpSchema.ToolJson,
  payloadSchema: McpSchema.ToolOutputJson,
});

export type EventDescriptor = typeof EventDescriptor.Type;

export const WireOccurrence = Schema.Struct({
  eventId: Schema.String,
  name: Schema.String,
  timestamp: Schema.String,
  data: Schema.Json,
  cursor: Cursor,
});

export type WireOccurrence = typeof WireOccurrence.Type;

const subscription = {
  _meta: Meta,
  name: Schema.String,
  arguments: Arguments,
  cursor: Cursor,
  maxAgeMs: Schema.optional(Schema.Finite),
};

export class ListEvents extends Rpc.make("events/list", {
  payload: { _meta: Meta, cursor: Schema.optional(Schema.String) },
  success: Schema.Struct({
    resultType: Schema.Literal("complete"),
    events: Schema.Array(EventDescriptor),
    _meta: Meta,
  }),
  error: EventsError,
}) {}

export class PollEvents extends Rpc.make("events/poll", {
  payload: { ...subscription, maxEvents: Schema.optional(Schema.Finite) },
  success: Schema.Struct({
    resultType: Schema.Literal("complete"),
    events: Schema.Array(WireOccurrence),
    cursor: Cursor,
    truncated: Schema.optional(Schema.Boolean),
    hasMore: Schema.optional(Schema.Boolean),
    nextPollMs: Schema.optional(Schema.Finite),
    _meta: Meta,
  }),
  error: EventsError,
}) {}

export class StreamEvents extends Rpc.make("events/stream", {
  payload: subscription,
  success: Schema.Struct({
    resultType: Schema.Literal("complete"),
    _meta: Meta,
  }),
  error: EventsError,
}) {}

export class SubscribeEvents extends Rpc.make("events/subscribe", {
  payload: {
    ...subscription,
    delivery: WebhookCallback.mapFields(
      Struct.assign({ mode: Schema.Literal("webhook") })
    ),
    ttlMs: webhookFields.ttlMs,
  },
  success: Schema.Struct({
    resultType: Schema.Literal("complete"),
    ...Subscribed.fields,
    _meta: Meta,
  }),
  error: EventsError,
}) {}

export class UnsubscribeEvents extends Rpc.make("events/unsubscribe", {
  payload: {
    _meta: Meta,
    name: Schema.String,
    arguments: Arguments,
    delivery: WebhookTarget,
  },
  success: Schema.Struct({
    resultType: Schema.Literal("complete"),
    _meta: Meta,
  }),
  error: EventsError,
}) {}

export const Active = Rpc.make("notifications/events/active", {
  payload: {
    _meta: Meta,
    cursor: Cursor,
    truncated: Schema.optional(Schema.Boolean),
  },
});

export const Occurred = Rpc.make("notifications/events/event", {
  payload: { ...WireOccurrence.fields, _meta: Meta },
});

export const Heartbeat = Rpc.make("notifications/events/heartbeat", {
  payload: { _meta: Meta, cursor: Cursor },
});

export const Failed = Rpc.make("notifications/events/error", {
  payload: { _meta: Meta, error: WireError },
});

export const Terminated = Rpc.make("notifications/events/terminated", {
  payload: { _meta: Meta, error: WireError },
});

export const Requests = RpcGroup.make(
  ListEvents,
  PollEvents,
  StreamEvents,
  SubscribeEvents,
  UnsubscribeEvents
);

export const Notifications = RpcGroup.make(
  Active,
  Occurred,
  Heartbeat,
  Failed,
  Terminated
);
