import { Cause, Effect, Match, Predicate, Schema, Stream } from "effect";
import { HttpClientError } from "effect/http";
import { RpcClientError } from "effect/rpc";

import * as Event from "../contract/Event.js";
import { readOn } from "../contract/push.js";
import type { Pushed } from "../contract/push.js";
import { isTransientReason, receivedFrom } from "../contract/transient.js";
import type { Transport } from "../contract/watch.js";

/** One subscription's stream over an event type's stream rpc, from the cursor it resumes from. */
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

// Why: Effect's HTTP protocol reads any status's body as frames, and fails one that ends before
// the call's exit, as a restart or a proxy cuts it, or holds no frame, as a 503's does, as a defect
// its message alone names; tests/rpc/events.test.ts cuts both through the protocol, so a change to
// either message fails it.
const cutResponses = [
  "HTTP response ended before RPC request completed",
  "Received empty HTTP response",
];

// Why: What a reconnect may outlast over a protocol is what it does over HTTP: its socket closing
// or failing, or its HTTP transport failing, a status a server sends while it recovers, or a
// body cut as it is read. Another protocol defect, a worker's failure, a refused upgrade or a
// close with an application's code, 4000 to 4999, which a server sends on purpose and
// `reconnectUntil` stops at, ends the watch.
/** Whether a watch's failure over an rpc protocol is one a reconnect may outlast. */
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

// Why: Effect's server answers a tag no layer serves with a defect its message alone names, as
// its own `Unknown request tag: <tag>`; tests/rpc/events.test.ts watches an unserved event, so a
// change to the message fails it.
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

/**
 * The transport of one subscription to `event` over its stream rpc: the stream alone, since an
 * rpc serves no poll, failing as `NotServed` where the server serves no such rpc, and once it goes
 * silent where `silenceEnds`.
 */
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
