import { Option, Schema, SchemaTransformation, Struct } from "effect";

import { Forbidden, Refusal } from "./errors.js";
import * as Event from "./Event.js";

export const eventCodes = {
  notFound: -32_023,
  forbidden: -32_024,
  unsupported: -32_026,
  callbackEndpoint: -32_027,
} as const;

export interface SentError {
  readonly code: number;
  readonly message: string;
  readonly data?: Schema.Json | undefined;
}

type Reason = Event.SubscriptionError["reason"];

interface Sent<A extends Reason> {
  readonly code: number;
  readonly data: Schema.Codec<A, unknown>;
}

const sent = {
  NotSubscribed: {
    code: eventCodes.notFound,
    data: Schema.Struct({ kind: Schema.Literal("subscription") }).pipe(
      Schema.decodeTo(
        Schema.instanceOf(Event.NotSubscribed),
        SchemaTransformation.transform({
          decode: () => new Event.NotSubscribed(),
          encode: () => ({ kind: "subscription" as const }),
        })
      )
    ),
  },
  NotServed: {
    code: eventCodes.notFound,
    data: Schema.Struct({ kind: Schema.Literal("event") }).pipe(
      Schema.decodeTo(
        Schema.instanceOf(Event.NotServed),
        SchemaTransformation.transform({
          decode: () => new Event.NotServed(),
          encode: () => ({ kind: "event" as const }),
        })
      )
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
        })
      )
    ),
  },
  CallbackFailed: {
    code: eventCodes.callbackEndpoint,
    data: Schema.Struct({ reason: Event.CallbackCategory }).pipe(
      Schema.decodeTo(
        Schema.instanceOf(Event.CallbackFailed),
        SchemaTransformation.transform({
          decode: ({ reason }) =>
            new Event.CallbackFailed({ category: reason }),
          encode: ({ category }) => ({ reason: category }),
        })
      )
    ),
  },
} satisfies {
  readonly [T in Reason["_tag"]]: Sent<Extract<Reason, { readonly _tag: T }>>;
};

const encodeRefusal = Schema.encodeUnknownSync(Schema.toCodecJson(Refusal));

const decodeRefusal = Schema.decodeUnknownOption(Schema.toCodecJson(Refusal));

export const sentError = (
  error: Event.SubscriptionError | Refusal
): SentError => {
  if (Schema.is(Refusal)(error)) {
    return {
      code: eventCodes.forbidden,
      message: error.message,
      data: encodeRefusal(error),
    };
  }

  const { code, data } = sent[error.reason._tag];

  return {
    code,
    message: error.message,
    data: Schema.encodeUnknownSync(Schema.toCodecJson(data))(error.reason),
  };
};

export const refusalOf = (error: {
  readonly message: string;
  readonly data?: unknown;
}): Refusal =>
  Option.getOrElse(
    decodeRefusal(error.data),
    () => new Forbidden({ message: error.message })
  );

export const reasonOf = (
  name: string,
  error: {
    readonly code?: number | undefined;
    readonly message: string;
    readonly data?: unknown;
  }
): Event.SubscriptionError | Refusal | undefined => {
  if (error.code === eventCodes.forbidden) {
    return refusalOf(error);
  }

  for (const { code, data } of Object.values(sent)) {
    const reason =
      code === error.code
        ? Schema.decodeUnknownOption(data)(error.data)
        : Option.none();

    if (Option.isSome(reason)) {
      return Event.SubscriptionError.of(name, reason.value);
    }
  }

  return undefined;
};
