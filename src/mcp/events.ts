import { ErrorReporter, Option, Schema } from "effect";
import { McpSchema } from "effect/ai";
import { Rpc, RpcGroup } from "effect/rpc";
import { Forbidden, Refusal } from "../contract/errors.js";
import * as Event from "../contract/Event.js";

/** The extension's identifier, its key in `capabilities.extensions`. */
export const extension = "io.modelcontextprotocol/events";

/** The `_meta` key a push stream's notifications carry its request id under. */
export const subscriptionIdKey = "io.modelcontextprotocol/subscriptionId";

// Why: SEP-3415's error codes, provisional until it is accepted, pinned to the PR head
// 2ec39b9c49c583411b73cb460dea5f52b5c541a6. A subscription's request fails with them, and its
// termination carries them.
const eventCodes = {
  notFound: -32023,
  forbidden: -32024,
  resourceExhausted: -32025,
  unsupported: -32026,
} as const;

// Why: Beside SEP-3415's codes, core MCP's and JSON-RPC's. tests/mcp/events.test.ts asserts them
// as sent.
export const codes = {
  headerMismatch: -32020,
  ...eventCodes,
  invalidParams: -32602,
  internal: -32603,
} as const;

const encodeRefusal = Schema.encodeUnknownSync(Schema.toCodecJson(Refusal));

const decodeRefusal = Schema.decodeUnknownOption(Schema.toCodecJson(Refusal));

/**
 * The error SEP-3415 ends a subscription with where its subscriber is refused: `-32024`, the
 * refusal's message, and the refusal as its data.
 */
export const terminationError = (refusal: Refusal) => ({
  code: eventCodes.forbidden,
  message: refusal.message,
  data: encodeRefusal(refusal),
});

/**
 * The refusal a SEP-3415 error carries, as `terminationError` writes one: its `data` decoded, or
 * `Forbidden` with its message where `data` is no refusal.
 */
const refusalOf = (error: { readonly message: string; readonly data?: unknown }): Refusal =>
  Option.getOrElse(decodeRefusal(error.data), () => new Forbidden({ message: error.message }));

const decodeUnsupported = Schema.decodeUnknownOption(
  Schema.Struct({ feature: Schema.String, value: Schema.optional(Schema.String) }),
);

const decodeLimit = Schema.decodeUnknownOption(
  Schema.Struct({ limit: Schema.String, max: Schema.optional(Schema.Number) }),
);

/**
 * What a SEP-3415 error of the event `name` names, as a subscription's request fails with one and
 * its termination carries one: a reason of `Event.SubscriptionError`, or the refusal; `undefined`
 * for a code SEP-3415 does not define, or one whose `data` does not say what it names.
 */
export const reasonOf = (
  name: string,
  error: { readonly code?: number | undefined; readonly message: string; readonly data?: unknown },
): Event.SubscriptionError | Refusal | undefined => {
  switch (error.code) {
    case eventCodes.notFound:
      return Event.SubscriptionError.of(name, new Event.NotServed());
    case eventCodes.forbidden:
      return refusalOf(error);
    case eventCodes.resourceExhausted:
      return Option.getOrUndefined(
        Option.map(decodeLimit(error.data), (limit) =>
          Event.SubscriptionError.of(name, new Event.LimitReached(limit)),
        ),
      );
    case eventCodes.unsupported:
      return Option.getOrUndefined(
        Option.map(decodeUnsupported(error.data), (unsupported) =>
          Event.SubscriptionError.of(name, new Event.Unsupported(unsupported)),
        ),
      );
    default:
      return undefined;
  }
};

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
  delivery: Schema.Array(Schema.Literals(["poll", "push"])),
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

export const Requests = RpcGroup.make(ListEvents, PollEvents, StreamEvents);

export const Notifications = RpcGroup.make(Active, Occurred, Heartbeat, Failed, Terminated);
