import { Duration, Effect, Match, Option, Predicate, Schema, Stream } from "effect";
import type { HttpClient, HttpClientResponse } from "effect/http";
import type { RpcGroup } from "effect/rpc";
import type * as Action from "../contract/Action.js";
import { InvalidInput, type Refusal } from "../contract/errors.js";
import type * as Event from "../contract/Event.js";
import { Checked, Gap, untaggedOccurrenceOf } from "../contract/occurrence.js";
import type { Fed, Page } from "../contract/pages.js";
import { Failed, type Pushed, readOn } from "../contract/push.js";
import { defaultNextPoll } from "../contract/feed.js";
import {
  failingWhenSilent,
  failingWhenUnanswered,
  isTransient,
  isTransientStatus,
} from "../contract/transient.js";
import { reasonOf } from "../contract/codes.js";
import { Receiving, webhookFed } from "../contract/receiving.js";
import { WebhookCallback, WebhookTarget } from "../contract/subscribe.js";
import type { Transport, WebhookTransport } from "../contract/watch.js";
import {
  Active,
  codes,
  Failed as FailedNotification,
  Heartbeat,
  type Notifications,
  Occurred,
  PollEvents,
  SubscribeEvents,
  Terminated,
  UnsubscribeEvents,
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
interface Watched<R = unknown> {
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

// Why: A frame is read as a reply, or as a notification whose params its method's rpc decodes, so
// the methods a push stream carries are the `Notifications` group's alone.
const Frame = Schema.Union([
  Schema.Struct({ error: WireError }),
  Schema.Struct({ method: Schema.String, params: Schema.optional(Schema.Json) }),
  Schema.Struct({ result: Schema.Unknown }),
]);

const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(Frame));

type Notified = RpcGroup.Rpcs<typeof Notifications>;

/** Reads one notification's params as what a push stream sends, where they decode. */
type Reader = (
  params: Schema.Json | undefined,
) => Option.Option<Effect.Effect<ReadonlyArray<Pushed>, unknown>>;

const reading = <N extends Notified>(
  rpc: N,
  read: (params: N["payloadSchema"]["Type"]) => Effect.Effect<ReadonlyArray<Pushed>, unknown>,
): Reader => {
  const decode = Schema.decodeUnknownOption(rpc.payloadSchema);

  return (params) => Option.map(decode(params), read);
};

const SubscribeReply = Schema.Union([
  Schema.Struct({ result: SubscribeEvents.successSchema }),
  Schema.Struct({ error: WireError }),
]);

const subscribeReplyOf = Schema.decodeUnknownOption(Schema.fromJsonString(SubscribeReply));

const UnsubscribeReply = Schema.Union([
  Schema.Struct({ result: UnsubscribeEvents.successSchema }),
  Schema.Struct({ error: WireError }),
]);

const unsubscribeReplyOf = Schema.decodeUnknownOption(Schema.fromJsonString(UnsubscribeReply));

const encodeCallback = Schema.encodeSync(WebhookCallback);

const encodeTarget = Schema.encodeSync(WebhookTarget);

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
): Transport<unknown, R | Receiving> => {
  const { name } = event;
  const untagged = untaggedOccurrenceOf(event);

  const occurrenceOf = (wire: WireOccurrence) => untagged({ ...wire, cursor: wire.cursor ?? null });

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

  /** The result of one `method` request, or what its error reply fails with. */
  const answered = <A>(
    method: string,
    params: { readonly [key: string]: Schema.Json },
    replyOf: (
      message: string,
    ) => Option.Option<{ readonly result: A } | { readonly error: WireError }>,
  ): Effect.Effect<A, unknown, R> =>
    Effect.gen(function* () {
      const messages = yield* bodyOf(method, name, yield* sent(method, params));

      const reply = messages.flatMap((message) => Option.toArray(replyOf(message))).at(-1);

      if (reply === undefined)
        return yield* Effect.fail(
          callError(method, name, new NoReply({ body: messages.join("\n") })),
        );

      if ("error" in reply) return yield* Effect.fail(failed(method, reply.error));

      return reply.result;
    }).pipe(failingWhenUnanswered);

  const poll = (cursor: string | null): Effect.Effect<Page, unknown, R> =>
    Effect.gen(function* () {
      const result = yield* answered("events/poll", { cursor }, pollReplyOf);

      return {
        events: yield* Effect.forEach(result.events, occurrenceOf),
        cursor: result.cursor ?? null,
        truncated: result.truncated === true,
        hasMore: result.hasMore === true,
        nextPoll:
          result.nextPollMs === undefined ? defaultNextPoll : Duration.millis(result.nextPollMs),
      };
    });

  const readers = new Map<string, Reader>(
    Object.entries({
      [Active._tag]: reading(Active, ({ cursor = null, truncated }) =>
        Effect.succeed([truncated === true ? Gap.make({ cursor }) : Checked.make({ cursor })]),
      ),
      [Occurred._tag]: reading(Occurred, (params) =>
        Effect.map(occurrenceOf(params), (occurrence) => [occurrence]),
      ),
      [Heartbeat._tag]: reading(Heartbeat, ({ cursor = null }) =>
        Effect.succeed([Checked.make({ cursor })]),
      ),
      [FailedNotification._tag]: reading(FailedNotification, () =>
        Effect.succeed([Failed.make({})]),
      ),
      [Terminated._tag]: reading(Terminated, ({ error }) =>
        Effect.fail(failed("events/stream", error)),
      ),
    } satisfies { readonly [K in Notified["_tag"]]: Reader }),
  );

  const framed = (data: string): Effect.Effect<ReadonlyArray<Pushed>, unknown> =>
    Option.match(decodeFrame(data), {
      onNone: () => Effect.succeed([]),
      onSome: (frame) => {
        if ("error" in frame) return Effect.fail(failed("events/stream", frame.error));

        if (!("method" in frame)) return Effect.succeed([]);

        const reader = readers.get(frame.method);

        if (reader === undefined) return Effect.succeed([]);

        // Why: Another notification on the stream is not the watch's to read, but one of its own
        // methods that does not decode leaves it unconfirmed, or blind, until its silence reconnects.
        return Option.getOrElse(reader(frame.params), () =>
          Effect.as(
            Effect.logWarning(`MCP event "${name}" sent a frame that does not decode: ${data}`),
            [],
          ),
        );
      },
    });

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
    ).pipe(readOn("MCP", name));

  const webhook: WebhookTransport<unknown, R | Receiving> = {
    receiver: Effect.service(Receiving),
    subscribe: ({ delivery, cursor, ttlMs }) =>
      answered(
        "events/subscribe",
        {
          delivery: { mode: "webhook", ...encodeCallback(delivery) },
          cursor,
          ...(ttlMs === undefined ? {} : { ttlMs }),
        },
        subscribeReplyOf,
      ),
    unsubscribe: ({ delivery }) =>
      Effect.asVoid(
        answered("events/unsubscribe", { delivery: encodeTarget(delivery) }, unsubscribeReplyOf),
      ),
    read: webhookFed(event),
  };

  return { name, poll, stream, webhook, transient };
};
