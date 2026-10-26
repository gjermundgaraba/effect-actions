import { Option, Schema, SchemaTransformation, Struct } from "effect";
import { Forbidden, Refusal } from "./errors.js";
import * as Event from "./Event.js";

// Why: SEP-3415's error codes, provisional until it is accepted, pinned to the PR head
// 2ec39b9c49c583411b73cb460dea5f52b5c541a6. A subscription's request fails with them, and its
// termination, in every delivery mode, carries them.
/** The error codes SEP-3415 defines, each naming one reason. */
export const eventCodes = {
  notFound: -32023,
  forbidden: -32024,
  unsupported: -32026,
  callbackEndpoint: -32027,
} as const;

/** A SEP-3415 error as sent: its code, its message, and what its `data` says. */
export interface SentError {
  readonly code: number;
  readonly message: string;
  readonly data?: Schema.Json | undefined;
}

type Reason = Event.SubscriptionError["reason"];

/** How one reason is sent: its code, and its `data`, which decodes to the reason again. */
interface Sent<A extends Reason> {
  readonly code: number;
  readonly data: Schema.Codec<A, unknown>;
}

// Why: Each reason's `data` is the one schema both directions read: a server's error is encoded
// by it, and a client's decoded, so the two cannot drift. `NotSubscribed` and `NotServed` share
// `notFound`, told apart by `kind`; `NotSubscribed` comes first, and `NotServed` takes any other
// `data`, as a server naming neither means the event.
const sent: { readonly [T in Reason["_tag"]]: Sent<Extract<Reason, { readonly _tag: T }>> } = {
  NotSubscribed: {
    code: eventCodes.notFound,
    data: Schema.Struct({ kind: Schema.Literal("subscription") }).pipe(
      Schema.decodeTo(
        Schema.instanceOf(Event.NotSubscribed),
        SchemaTransformation.transform({
          decode: () => new Event.NotSubscribed(),
          encode: () => ({ kind: "subscription" as const }),
        }),
      ),
    ),
  },
  NotServed: {
    code: eventCodes.notFound,
    data: Schema.UndefinedOr(Schema.Json).pipe(
      Schema.decodeTo(
        Schema.instanceOf(Event.NotServed),
        SchemaTransformation.transform<Event.NotServed, Schema.Json | undefined>({
          decode: () => new Event.NotServed(),
          encode: () => ({ kind: "event" }),
        }),
      ),
    ),
  },
  Unsupported: {
    code: eventCodes.unsupported,
    data: Schema.Struct(Struct.omit(Event.Unsupported.fields, ["_tag"])).pipe(
      Schema.decodeTo(
        Schema.instanceOf(Event.Unsupported),
        SchemaTransformation.transform({
          decode: (fields) => new Event.Unsupported(fields),
          encode: ({ feature, value }) => ({ feature, value }),
        }),
      ),
    ),
  },
  // Why: SEP-3415 names the category `reason`, which `Event.CallbackFailed` calls `category`
  // beside `Event.SubscriptionError`'s own `reason`.
  CallbackFailed: {
    code: eventCodes.callbackEndpoint,
    data: Schema.Struct({ reason: Event.CallbackCategory }).pipe(
      Schema.decodeTo(
        Schema.instanceOf(Event.CallbackFailed),
        SchemaTransformation.transform({
          decode: ({ reason }) => new Event.CallbackFailed({ category: reason }),
          encode: ({ category }) => ({ reason: category }),
        }),
      ),
    ),
  },
};

const encodeRefusal = Schema.encodeUnknownSync(Schema.toCodecJson(Refusal));

const decodeRefusal = Schema.decodeUnknownOption(Schema.toCodecJson(Refusal));

/**
 * The SEP-3415 error `error` is sent as: a refusal's `-32024`, its message and the refusal as
 * its data, or its reason's code and data beside its message.
 */
export const sentError = (error: Event.SubscriptionError | Refusal): SentError => {
  if (Schema.is(Refusal)(error))
    return { code: eventCodes.forbidden, message: error.message, data: encodeRefusal(error) };

  const { code, data } = sent[error.reason._tag];

  return {
    code,
    message: error.message,
    data: Schema.encodeUnknownSync(Schema.toCodecJson(data))(error.reason),
  };
};

/**
 * The refusal a SEP-3415 error carries, as `sentError` writes one: its `data` decoded, or
 * `Forbidden` with its message where `data` is no refusal.
 */
export const refusalOf = (error: { readonly message: string; readonly data?: unknown }): Refusal =>
  Option.getOrElse(decodeRefusal(error.data), () => new Forbidden({ message: error.message }));

/**
 * What a SEP-3415 error of the event `name` names, as a subscription's request fails with one and
 * its termination carries one: a reason of `Event.SubscriptionError`, or the refusal; `undefined`
 * for a code SEP-3415 does not define, or one whose `data` does not say what it names.
 */
export const reasonOf = (
  name: string,
  error: { readonly code?: number | undefined; readonly message: string; readonly data?: unknown },
): Event.SubscriptionError | Refusal | undefined => {
  if (error.code === eventCodes.forbidden) return refusalOf(error);

  for (const { code, data } of Object.values(sent)) {
    const reason =
      code === error.code ? Schema.decodeUnknownOption(data)(error.data) : Option.none();

    if (Option.isSome(reason)) return Event.SubscriptionError.of(name, reason.value);
  }

  return undefined;
};
