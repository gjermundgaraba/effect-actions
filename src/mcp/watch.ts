import { Duration, Effect, Match, Option, Predicate, Schema, Stream } from "effect";
import type { HttpClient, HttpClientResponse } from "effect/http";
import type * as Action from "../contract/Action.js";
import { InvalidInput, type Refusal } from "../contract/errors.js";
import type * as Event from "../contract/Event.js";
import { Checked, Gap, untaggedOccurrenceOf } from "../contract/occurrence.js";
import type { Fed, Page } from "../contract/pages.js";
import { defaultNextPoll } from "../contract/feed.js";
import {
  failingWhenSilent,
  failingWhenUnanswered,
  isTransient,
  isTransientStatus,
} from "../contract/transient.js";
import type { Transport } from "../contract/watch.js";
import {
  codes,
  Notification,
  PollEvents,
  reasonOf,
  WireError,
  type WireOccurrence,
} from "./events.js";
import {
  bodyOf,
  callError,
  failWith,
  framesOf,
  isEventStream,
  McpCallError,
  NoReply,
  ProtocolError,
  StatusError,
} from "./reply.js";
import { request } from "./request.js";

/** What a watch's request needs of the client: its HTTP client, the endpoint, the event. */
export interface Watched<R = unknown> {
  readonly http: Pick<HttpClient.HttpClient.With<unknown, R>, "execute">;
  readonly url: string;
  readonly event: Event.Any;
  /** The refusals a 401 or 403 decodes as: the built-in ones, and the descriptor's errors. */
  readonly refusedWith: Action.Errors;
}

const PollReply = Schema.Union([
  Schema.Struct({ result: PollEvents.successSchema }),
  Schema.Struct({ error: WireError }),
]);

const pollReplyOf = Schema.decodeUnknownOption(Schema.fromJsonString(PollReply));

const StreamFrame = Schema.Union([
  Notification,
  Schema.Struct({ result: Schema.Unknown }),
  Schema.Struct({ error: WireError }),
]);

const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(StreamFrame));

const decodeMethod = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ method: Schema.String })),
);

// Why: An endpoint's transient status, and an internal error answering a poll or a stream, which
// `layerHttp` answers for a source's failure, are what a 5xx is to an HTTP watch: a reconnect may
// outlast them. The client reads a status itself, so it is an `McpCallError`, not an
// `HttpClientError`.
const transientReason = (reason: McpCallError["reason"]): boolean =>
  Match.value(reason).pipe(
    Match.tag("StatusError", ({ status }) => isTransientStatus(status)),
    Match.tag("ProtocolError", ({ code }) => code === codes.internal),
    Match.orElse(() => false),
  );

const isMcpCallError: Predicate.Refinement<unknown, McpCallError> = Schema.is(McpCallError);

const transient = Predicate.or(
  isTransient,
  Predicate.compose(isMcpCallError, ({ reason }) => transientReason(reason)),
);

/**
 * The transport of one subscription over an MCP endpoint served by `layerHttp`: `events/poll`
 * for each page, and `events/stream` read as it arrives, each failing as the endpoint answered.
 */
export const transportOf = <R>(
  { http, url, event, refusedWith }: Watched<R>,
  input: Schema.Json,
): Transport<unknown, R> => {
  const { name } = event;
  const untagged = untaggedOccurrenceOf(event);

  const occurrenceOf = (wire: WireOccurrence, cursor: string | null) =>
    untagged({ ...wire, cursor });

  // Why: A refusal the endpoint's authentication answers is a 401 or a 403 with the refusal's
  // JSON, as for a tool's call; one the event's authorizer answers is SEP-3415's `Forbidden`,
  // its `data` the refusal's JSON.
  const failed = (
    method: string,
    error: WireError,
  ): Event.SubscriptionError | Refusal | InvalidInput | McpCallError =>
    reasonOf(name, error) ??
    (error.code === codes.invalidParams
      ? new InvalidInput({ message: error.message })
      : callError(method, name, new ProtocolError(error)));

  const sent = (method: string, params: { readonly [key: string]: Schema.Json }) =>
    Effect.flatMap(
      http.execute(request(method, { name, arguments: input, ...params }, { url })),
      (response) =>
        response.status === 200
          ? Effect.succeed(response)
          : Effect.flatMap(response.text, (body) =>
              failWith(
                refusedWith,
                body,
                callError(method, name, new StatusError({ status: response.status, body })),
              ),
            ),
    );

  const answered = <A>(
    method: string,
    params: { readonly [key: string]: Schema.Json },
    replyOf: (
      message: string,
    ) => Option.Option<{ readonly result: A } | { readonly error: WireError }>,
  ): Effect.Effect<A, unknown, R> =>
    Effect.gen(function* () {
      const messages = yield* bodyOf(method, name, yield* sent(method, params));

      const reply = Option.fromNullishOr(
        messages.flatMap((message) => Option.toArray(replyOf(message))).at(-1),
      );

      if (Option.isNone(reply))
        return yield* Effect.fail(
          callError(method, name, new NoReply({ body: messages.join("\n") })),
        );

      if ("error" in reply.value) return yield* Effect.fail(failed(method, reply.value.error));

      return reply.value.result;
    }).pipe(failingWhenUnanswered);

  const poll = (cursor: string | null): Effect.Effect<Page, unknown, R> =>
    Effect.gen(function* () {
      const result = yield* answered("events/poll", { cursor }, pollReplyOf);
      const last = result.events.length - 1;

      // Why: A poll carries one cursor, the page's: an occurrence before the last resumes from
      // the cursor the page was asked for, as a check's does in process.
      const events = yield* Effect.forEach(result.events, (wire, index) =>
        occurrenceOf(wire, index === last ? (result.cursor ?? null) : cursor),
      );

      return {
        events,
        cursor: result.cursor ?? null,
        truncated: result.truncated === true,
        hasMore: result.hasMore === true,
        nextPoll:
          result.nextPollMs === undefined ? defaultNextPoll : Duration.millis(result.nextPollMs),
      };
    });

  const framed = (data: string): Effect.Effect<ReadonlyArray<Fed>, unknown> => {
    const frame = decodeFrame(data);

    // Why: Another notification on the stream is not the watch's to read, but one of its own
    // methods that does not decode leaves it unconfirmed, or blind, until its silence reconnects.
    if (Option.isNone(frame))
      return Option.exists(decodeMethod(data), ({ method }) =>
        method.startsWith("notifications/events/"),
      )
        ? Effect.as(
            Effect.logWarning(`MCP event "${name}" sent a frame that does not decode: ${data}`),
            [],
          )
        : Effect.succeed([]);

    const value = frame.value;

    if ("error" in value) return Effect.fail(failed("events/stream", value.error));

    if (!("method" in value)) return Effect.succeed([]);

    switch (value.method) {
      case "notifications/events/active":
        return Effect.succeed([
          value.params.truncated === true
            ? Gap.make({ cursor: value.params.cursor ?? null })
            : Checked.make({ cursor: value.params.cursor ?? null }),
        ]);
      case "notifications/events/event":
        return Effect.map(occurrenceOf(value.params, value.params.cursor ?? null), (occurrence) => [
          occurrence,
        ]);
      case "notifications/events/heartbeat":
        return Effect.succeed([Checked.make({ cursor: value.params.cursor ?? null })]);
      case "notifications/events/error":
        return Effect.as(
          Effect.logWarning(`MCP event "${name}" reported an error: ${value.params.error.message}`),
          [],
        );
      case "notifications/events/terminated":
        return Effect.fail(failed("events/stream", value.params.error));
    }
  };

  const read = (response: HttpClientResponse.HttpClientResponse) =>
    framesOf("events/stream", name, response).pipe(
      failingWhenSilent,
      Stream.mapEffect(framed),
      Stream.flattenIterable,
    );

  const stream = (cursor: string | null): Stream.Stream<Fed, unknown, R> =>
    Stream.unwrap(
      // Why: A server may hold the stream's status back until its first read is done, as
      // Effect's HTTP protocol does, so the wait for it is bounded as a silence is.
      Effect.map(failingWhenUnanswered(sent("events/stream", { cursor })), (response) =>
        isEventStream(response)
          ? read(response)
          : Stream.fromIterableEffect(failingWhenUnanswered(Effect.flatMap(response.text, framed))),
      ),
    );

  return { name, poll, stream, transient };
};
