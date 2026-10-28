import {
  Cause,
  Duration,
  Effect,
  Function,
  Match,
  Predicate,
  Stream,
} from "effect";
import { HttpClientError } from "effect/http";

import type { Fed } from "./pages.js";
import { readOn } from "./push.js";
import type { Pushed } from "./push.js";
import { isTransientStatus } from "./status.js";

export const answeredStatus = ({
  reason,
}: HttpClientError.HttpClientError): number | undefined =>
  Match.value(reason).pipe(
    Match.tag(
      "StatusCodeError",
      "DecodeError",
      ({ response }) => response.status
    ),
    Match.orElse(Function.constUndefined)
  );

export const isTransientReason = (
  reason: HttpClientError.HttpClientError["reason"]
): boolean =>
  Match.value(reason).pipe(
    Match.tag("TransportError", () => true),
    Match.tag(
      "DecodeError",
      ({ response }) =>
        response.status < 300 || isTransientStatus(response.status)
    ),
    Match.tag("StatusCodeError", ({ response }) =>
      isTransientStatus(response.status)
    ),
    Match.orElse(() => false)
  );

export const isTransient = Predicate.or(
  Cause.isTimeoutError,
  Predicate.compose(HttpClientError.isHttpClientError, ({ reason }) =>
    isTransientReason(reason)
  )
);

const silentFor = Duration.seconds(60);

export const failingWhenUnanswered = <A, E, R>(
  request: Effect.Effect<A, E, R>
): Effect.Effect<A, E | Cause.TimeoutError, R> =>
  Effect.timeout(request, silentFor);

export const failingWhenSilent = <A, E, R>(
  stream: Stream.Stream<A, E, R>
): Stream.Stream<A, E | Cause.TimeoutError, R> =>
  stream.pipe(
    Stream.timeoutOrElse({
      duration: silentFor,
      orElse: () =>
        Stream.fail(new Cause.TimeoutError("The event stream went silent")),
    })
  );

export const receivedFrom =
  (surface: string, name: string) =>
  <E, R>(
    sent: Stream.Stream<Pushed, E, R>
  ): Stream.Stream<Fed, E | Cause.TimeoutError, R> =>
    sent.pipe(failingWhenSilent, readOn(surface, name));
