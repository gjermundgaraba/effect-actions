import { Cause, Effect, Match, Predicate, Schema, Stream } from "effect";
import { HttpClientError } from "effect/http";
import { RpcClientError } from "effect/rpc";

import * as Event from "../contract/Event.js";
import { readOn } from "../contract/push.js";
import type { Pushed } from "../contract/push.js";
import { isTransientReason, receivedFrom } from "../contract/transient.js";
import type { Transport } from "../contract/watch.js";

export type StreamMethod = (
  cursor: string | null
) => Stream.Stream<Pushed, unknown>;

const isRpcClientError = Schema.is(RpcClientError.RpcClientError);

const isAnsweredReason = Schema.is(
  Schema.Union([
    Schema.instanceOf(HttpClientError.TransportError),
    Schema.instanceOf(HttpClientError.StatusCodeError),
    Schema.instanceOf(HttpClientError.DecodeError),
  ])
);

const cutResponses = [
  "HTTP response ended before RPC request completed",
  "Received empty HTTP response",
];

export const isRpcTransient = Predicate.or(
  Cause.isTimeoutError,
  (error) =>
    isRpcClientError(error) &&
    Match.value(error.reason).pipe(
      Match.tag(
        "SocketReadError",
        "SocketWriteError",
        "SocketOpenError",
        () => true
      ),
      Match.tag("SocketCloseError", ({ code }) => code < 4000 || code > 4999),
      Match.tag(
        "HttpError",
        ({ cause }) => isAnsweredReason(cause) && isTransientReason(cause)
      ),
      Match.tag("RpcClientDefect", ({ message }) =>
        cutResponses.some((fragment) => message.includes(fragment))
      ),
      Match.orElse(() => false)
    )
);

const isUnknownTag = (tag: string) => {
  const message = `Unknown request tag: ${tag}`;

  return (cause: Cause.Cause<unknown>): boolean =>
    cause.reasons.some(
      (reason) =>
        Cause.isDieReason(reason) &&
        (Predicate.hasProperty(reason.defect, "message")
          ? reason.defect.message === message
          : reason.defect === message)
    );
};

export const transportOf = (
  event: Event.Any,
  stream: StreamMethod,
  silenceEnds: boolean
): Transport<unknown, never> => {
  const notServed = Stream.fail(
    Event.SubscriptionError.of(event.name, new Event.NotServed())
  );

  const unknownTag = isUnknownTag(event.name);

  return {
    name: event.name,
    poll: () =>
      Effect.fail(
        Event.SubscriptionError.of(
          event.name,
          new Event.Unsupported({ feature: "deliveryMode", value: "poll" })
        )
      ),
    stream: (cursor) =>
      stream(cursor).pipe(
        Stream.catchCauseIf(unknownTag, () => notServed),
        silenceEnds
          ? receivedFrom("RPC", event.name)
          : readOn("RPC", event.name)
      ),
    transient: isRpcTransient,
  };
};
