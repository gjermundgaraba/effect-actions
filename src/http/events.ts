import { Duration, Effect, Schema, Stream } from "effect";
import { HttpServerRequest } from "effect/http";
import { HttpApiEndpoint, HttpApiSchema, OpenApi } from "effect/http-api";
import type { Any as Authentication } from "../authentication/provider.js";
import { Refusal } from "../contract/errors.js";
import type * as Action from "../contract/Action.js";
import type * as Event from "../contract/Event.js";
import { principalOf } from "../contract/caller.js";
import type { Feed } from "../contract/feed.js";
import type { ErasedValue } from "../contract/implementation.js";
import { OccurrenceOf } from "../contract/occurrence.js";
import { PushedOf, queuedPush, SubscriptionOf } from "../contract/push.js";
import { declared } from "../contract/status.js";

/** One poll's answer: the occurrences since the cursor, and when to ask again. */
export const pageOf = <E extends Event.Any>(event: E) =>
  Schema.Struct({
    events: Schema.Array(OccurrenceOf(event)),
    cursor: Schema.NullOr(Schema.String),
    truncated: Schema.Boolean,
    hasMore: Schema.Boolean,
    nextPollMs: Schema.Finite,
  });

const dataOf = <E extends Event.Any>(event: E) => Schema.toCodecJson(PushedOf(event));

/**
 * What a subscription's event stream sends, each as one SSE `message`: a `Checked` with the
 * position it starts from, or a `Gap` where that was no longer served, then each occurrence, a
 * `Gap` where some were missed, a `Checked` every 30 seconds, and a `Failed` where reading
 * failed and resumes. A later refusal ends it, as Effect's stream failure event.
 */
export const sentOf = <E extends Event.Any>(event: E) =>
  HttpApiSchema.StreamSse({ data: dataOf(event), error: Refusal });

// Why: A POST, as an action's route, since a subscription's input is JSON and its credential a
// header; a browser's `EventSource` sends neither, so a browser watches with `fetchClient`.
/** The route of one event type at `path`, its poll answered as JSON and its stream as SSE. */
export const eventEndpointOf = (event: Event.Any, path: `/${string}`, errors: Action.Errors) =>
  HttpApiEndpoint.post(event.name, path, {
    payload: SubscriptionOf(event).pipe(HttpApiSchema.asJson()),
    success: [pageOf(event), sentOf(event)],
    error: errors.map(declared),
  }).annotate(OpenApi.Description, event.description);

/**
 * Answers a subscription's request to `feed`: a page, or, where it accepts `text/event-stream`,
 * the subscription's stream. Both admit the subscriber first, so a refusal is the route's error;
 * `authentication`'s principal names a poll's subscriber, for its `subscription` hook.
 */
export const answering =
  (feed: Feed, authentication: Authentication | undefined) =>
  ({
    payload: { input, cursor = null },
  }: {
    readonly payload: { readonly input: ErasedValue; readonly cursor?: string | null | undefined };
  }) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;

      if ((request.headers.accept ?? "").includes("text/event-stream")) {
        const open = yield* feed.stream(input);
        const encode = Schema.encodeEffect(dataOf(feed.event));

        return Stream.fromQueue(
          yield* queuedPush(open, cursor, (sent) => Effect.as(encode(sent), sent)),
        );
      }

      const subscriber = yield* principalOf(feed.event, authentication);
      const page = yield* feed.poll(input, cursor, { subscriber });

      return {
        events: page.events,
        cursor: page.cursor,
        truncated: page.truncated,
        hasMore: page.hasMore,
        nextPollMs: Duration.toMillis(page.nextPoll),
      };
    });
