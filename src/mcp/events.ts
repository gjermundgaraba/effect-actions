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

/** The extension's identifier, its key in `capabilities.extensions`. */
export const extension = "io.modelcontextprotocol/events";

/** The `_meta` key a push stream's notifications carry its request id under. */
export const subscriptionIdKey = "io.modelcontextprotocol/subscriptionId";

// Why: Beside SEP-3415's codes, `eventCodes`, provisional until it is accepted, core MCP's and
// JSON-RPC's. tests/mcp/events.test.ts asserts them as sent.
export const codes = {
  headerMismatch: -32020,
  ...eventCodes,
  invalidParams: -32602,
  internal: -32603,
} as const;

const Meta = Schema.optional(Schema.Record(Schema.String, Schema.Json));

const Arguments = Schema.optional(Schema.Record(Schema.String, Schema.Json));

// Why: An absent cursor is `null`, in a request and in an answer, as SEP-3415 says.
const Cursor = Schema.optional(Schema.NullOr(Schema.String));

/** A JSON-RPC error as an `events/*` request fails with, and a termination carries. */
export const WireError = Schema.Struct({
  code: Schema.Int,
  message: Schema.String,
  data: Schema.optional(Schema.Json),
});

export type WireError = typeof WireError.Type;

/** What an `events/*` handler fails with: the JSON-RPC error it answers. */
export class EventsError extends Schema.Error<EventsError>("effect-actions/McpEventsError")(
  WireError.fields,
) {
  // Why: Each is the subscriber's answer, a refusal or a request it got wrong, as a tool call's
  // is, and goes to no reporter; an internal failure's cause is reported where it is answered.
  override readonly [ErrorReporter.ignore] = true;
}

/** One event type as `events/list` lists it. */
export const EventDescriptor = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  delivery: Schema.Array(Schema.Literals(["poll", "push", "webhook"])),
  inputSchema: McpSchema.ToolJson,
  payloadSchema: McpSchema.ToolOutputJson,
});

export type EventDescriptor = typeof EventDescriptor.Type;

/** An occurrence on the wire: in a poll's `events`, and the params of an event notification. */
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
  success: Schema.Struct({ resultType: Schema.Literal("complete"), _meta: Meta }),
  error: EventsError,
}) {}

export class SubscribeEvents extends Rpc.make("events/subscribe", {
  payload: {
    ...subscription,
    delivery: WebhookCallback.mapFields(Struct.assign({ mode: Schema.Literal("webhook") })),
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
  success: Schema.Struct({ resultType: Schema.Literal("complete"), _meta: Meta }),
  error: EventsError,
}) {}

export const Active = Rpc.make("notifications/events/active", {
  payload: { _meta: Meta, cursor: Cursor, truncated: Schema.optional(Schema.Boolean) },
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
  UnsubscribeEvents,
);

export const Notifications = RpcGroup.make(Active, Occurred, Heartbeat, Failed, Terminated);
