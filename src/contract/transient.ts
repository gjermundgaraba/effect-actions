import { Cause, Duration, Effect, Match, Predicate, Stream } from "effect";
import { HttpClientError } from "effect/http";
import type { Fed } from "./pages.js";
import { type Pushed, readOn } from "./push.js";
import { isTransientStatus } from "./status.js";

// Why: A raw client fails a status with `StatusCodeError`, and a native `HttpApiClient` one its
// endpoint does not declare with `DecodeError`, both holding the response.
/** The status a server answered with, where `error` is a failure to read its answer. */
export const answeredStatus = ({ reason }: HttpClientError.HttpClientError): number | undefined =>
  Match.value(reason).pipe(
    Match.tag("StatusCodeError", "DecodeError", ({ response }) => response.status),
    Match.orElse(() => undefined),
  );

/** Whether `error` is an HTTP client's failure on a 404 answer. */
export const isNotFound = Predicate.compose(
  HttpClientError.isHttpClientError,
  (error) => answeredStatus(error) === 404,
);

// Why: A `DecodeError` on a success is its body failing as it is read, such as a stream a proxy
// or a restart cut: the transport's failure, not the server's answer.
/** Whether an HTTP client's failure, by its `reason`, is one a reconnect may outlast. */
export const isTransientReason = (reason: HttpClientError.HttpClientError["reason"]): boolean =>
  Match.value(reason).pipe(
    Match.tag("TransportError", () => true),
    Match.tag(
      "DecodeError",
      ({ response }) => response.status < 300 || isTransientStatus(response.status),
    ),
    Match.tag("StatusCodeError", ({ response }) => isTransientStatus(response.status)),
    Match.orElse(() => false),
  );

/** Whether a remote watch's failure is one a reconnect may outlast. */
export const isTransient = Predicate.or(
  Cause.isTimeoutError,
  Predicate.compose(HttpClientError.isHttpClientError, ({ reason }) => isTransientReason(reason)),
);

// Why: A server sends a heartbeat at least every 30 seconds, so a stream silent for twice that
// is dead, as SEP-3415 says, such as one a proxy holds open without passing frames on.
const silentFor = Duration.seconds(60);

/**
 * `request`, failing with a `TimeoutError`, which `isTransient` admits, when it is unanswered for
 * as long as a stream may be silent, such as a server that holds its status back.
 */
export const failingWhenUnanswered = <A, E, R>(
  request: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Cause.TimeoutError, R> => Effect.timeout(request, silentFor);

/** `stream`, failing with a `TimeoutError`, which `isTransient` admits, once it goes silent. */
export const failingWhenSilent = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
): Stream.Stream<A, E | Cause.TimeoutError, R> =>
  stream.pipe(
    Stream.timeoutOrElse({
      duration: silentFor,
      orElse: () => Stream.fail(new Cause.TimeoutError("The event stream went silent")),
    }),
  );

/**
 * What a client reads from a push stream of `surface`'s event `name`: each element but `Failed`,
 * which is logged, the server having read on; failing with a `TimeoutError` once it goes silent.
 */
export const receivedFrom =
  (surface: string, name: string) =>
  <E, R>(sent: Stream.Stream<Pushed, E, R>): Stream.Stream<Fed, E | Cause.TimeoutError, R> =>
    sent.pipe(failingWhenSilent, readOn(surface, name));
