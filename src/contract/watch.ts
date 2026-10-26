import { Cause, Clock, Duration, Effect, Predicate, Queue, Schedule, Schema, Stream } from "effect";
import { CallbackUrl } from "./callback.js";
import * as Event from "./Event.js";
import { Checked, Gap } from "./occurrence.js";
import { type Fed, type Page, paged } from "./pages.js";
import { type Delivered, type Receiving, watchParameter } from "./receiving.js";
import { makeRecent } from "./recent.js";
import type { AnyWebhookCancellation, AnyWebhookSubscription, Subscribed } from "./subscribe.js";

/** A webhook subscription a watch asks for: where to POST, signed how, from where, for how long. */
export type WebhookRequest = Omit<AnyWebhookSubscription, "input">;

/** What a subscribe answers a watch: when to refresh by, and where delivery starts. */
export type Grant = Pick<Subscribed, "refreshBefore" | "cursor" | "truncated">;

/**
 * How a client keeps one webhook subscription: the receiver its deliveries reach, subscribing, or
 * refreshing, and unsubscribing at its surface, and reading each body delivered to it.
 */
export interface WebhookTransport<E, R> {
  readonly receiver: Effect.Effect<Receiving["Service"], never, R>;
  readonly subscribe: (request: WebhookRequest) => Effect.Effect<Grant, E, R>;
  readonly unsubscribe: (
    request: Omit<AnyWebhookCancellation, "input">,
  ) => Effect.Effect<void, E, R>;
  readonly read: (body: Delivered) => Effect.Effect<ReadonlyArray<Fed>, E>;
}

/**
 * How a client reaches one subscription to the event `name`: a poll from a cursor, a stream from
 * one, each failing with `Unsupported` where its surface serves no such mode, and a webhook
 * subscription where it delivers by webhook. Each answers decoded occurrences. Where the stream
 * crosses a network, `transient` says which of its failures a reconnect may outlast.
 */
export interface Transport<E, R> {
  readonly name: string;
  readonly poll: (cursor: string | null) => Effect.Effect<Page, E, R>;
  readonly stream: (cursor: string | null) => Stream.Stream<Fed, E, R>;
  readonly webhook?: WebhookTransport<E, R> | undefined;
  readonly transient?: ((error: E) => boolean) | undefined;
}

const reconnectDelay = Duration.seconds(1);

const maxReconnectDelay = Duration.seconds(30);

// Why: `Stream.retry` starts its schedule again at the first element after a failure, so the
// backoff counts only the failures since the stream last delivered.
const afterFailures = <E>(transient: (error: E) => boolean) =>
  Schedule.min([Schedule.exponential(reconnectDelay), Schedule.spaced(maxReconnectDelay)]).pipe(
    Schedule.setInputType<E>(),
    Schedule.while(({ input }) => transient(input)),
    Schedule.tap(({ input, duration }) =>
      Effect.logWarning(
        `A watch reconnects in ${Duration.format(duration)} after a failure`,
        input,
      ),
    ),
  );

const isSubscriptionError: Predicate.Refinement<unknown, Event.SubscriptionError> = Schema.is(
  Event.SubscriptionError,
);

/** Whether a watch's failure says the server serves its event by poll alone, refusing to push it. */
const pushRefused = Predicate.compose(
  isSubscriptionError,
  ({ reason }) =>
    Predicate.isTagged(reason, "Unsupported") &&
    reason.feature === "deliveryMode" &&
    reason.value === "push",
);

// Why: Duplicates arrive within a reconnect or a replay of the last page, so the ids of the last
// thousand occurrences are enough, and a long watch holds no more.
const dedupeWindow = 1000;

/**
 * The occurrences and gaps of one subscription, as every client's `watch` answers them. Each run
 * starts from `options`: what one run saw, the cursor and the ids it deduplicates by, ends with
 * it, and only `resume` carries a cursor to the next.
 */
export const watching = <E, R, SE>(
  transport: Transport<E, R>,
  { cursor: given, mode, resume }: Event.WatchOptions<SE> = {},
): Stream.Stream<
  Event.Received<Event.Any>,
  E | SE | Event.SubscriptionError | Schema.SchemaError,
  R
> =>
  Stream.suspend(() => {
    const seen = makeRecent(dedupeWindow);
    let pending: string | null = null;

    const keep = (cursor: string | null): Effect.Effect<void, SE> =>
      cursor === null || resume === undefined ? Effect.void : resume.store.set(resume.key, cursor);

    const fresh = (eventId: string) => {
      if (seen.has(eventId)) return false;

      seen.add(eventId);

      return true;
    };

    // Why: A position is kept once what came before it is handled: an occurrence's when the next
    // element is pulled, which a consumer does after handling it, and a page's end as it is read,
    // after its occurrences. A consumer stopped mid-way then receives the unhandled one again.
    const handled = Effect.fnUntraced(function* (
      fed: Fed,
    ): Effect.fn.Return<ReadonlyArray<Event.Received<Event.Any>>, SE> {
      yield* keep(pending);
      pending = null;

      if (Predicate.isTagged(fed, "Checked")) {
        yield* keep(fed.cursor);

        return [];
      }

      if (Predicate.isTagged(fed, "Gap")) return [fed];

      pending = fed.cursor;

      return fresh(fed.eventId) ? [fed] : [];
    });

    const start: Effect.Effect<string | null, SE> =
      given !== undefined || resume === undefined
        ? Effect.succeed(given ?? null)
        : Effect.map(resume.store.get(resume.key), (kept) => kept ?? null);

    // Why: A subscription that ends or drops for a reason `transient` admits reopens from the last
    // position it reached, as long as the watch is read: a second after it ends, and after a
    // failure later each time, doubling to 30 seconds, until something arrives again. Each
    // reconnect is logged, and the watch's error channel keeps the failures it cannot outlast.
    // One that refuses to push, where `polled` is given, polls instead from that position.
    const reconnecting = (
      open: (cursor: string | null) => Stream.Stream<Fed, E, R>,
      cursor: string | null,
      polled?: (cursor: string | null) => Stream.Stream<Fed, E, R>,
    ): Stream.Stream<Fed, E, R> => {
      const { transient } = transport;
      let at = cursor;

      const once = Stream.suspend(() => open(at)).pipe(
        Stream.tap((fed) =>
          Effect.sync(() => {
            at = fed.cursor ?? at;
          }),
        ),
      );

      const reopened =
        transient === undefined
          ? once
          : once.pipe(
              Stream.repeat(Schedule.spaced(reconnectDelay)),
              Stream.retry(afterFailures(transient)),
            );

      return polled === undefined
        ? reopened
        : reopened.pipe(Stream.catchIf(pushRefused, () => Stream.suspend(() => polled(at))));
    };

    const polled = (cursor: string | null) =>
      reconnecting((at) => paged(transport.poll, at), cursor);

    // Why: A watch keeps one place at the receiver, and one subscription, for as long as it runs:
    // a reconnect refreshes it, and what the receiver accepted waits for the watch through it.
    // Its callback is checked before it takes a place, so one the server would refuse fails here.
    const webhooked = ({ baseUrl, ttl }: Event.WebhookDelivery, cursor: string | null) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const { webhook } = transport;

          if (webhook === undefined)
            return yield* Effect.fail(
              Event.SubscriptionError.of(
                transport.name,
                new Event.Unsupported({ feature: "deliveryMode", value: "webhook" }),
              ),
            );

          const base = yield* Schema.decodeUnknownEffect(CallbackUrl)(baseUrl);
          const receiving = yield* webhook.receiver;
          const received = yield* Queue.unbounded<Effect.Effect<ReadonlyArray<Fed>, E>>();

          const { id, secret } = yield* receiving.register(
            (body) =>
              Queue.sizeUnsafe(received) < capacity &&
              Queue.offerUnsafe(received, webhook.read(body)),
          );

          const url = new URL(`${base.pathname.replace(/\/$/u, "")}${receiving.path}`, base);

          url.searchParams.set(watchParameter, id);

          const request = {
            delivery: { url, secret },
            ttlMs: ttl === undefined ? undefined : Duration.toMillis(Duration.fromInputUnsafe(ttl)),
          };

          yield* Effect.addFinalizer(() =>
            webhook
              .unsubscribe({ delivery: { url } })
              .pipe(Effect.timeout(unsubscribeTimeout), Effect.ignore),
          );

          return reconnecting((at) => delivered(webhook, request, received, at), cursor);
        }),
      );

    return Stream.unwrap(
      Effect.map(start, (cursor) =>
        Predicate.isTagged(mode, "WebhookDelivery")
          ? webhooked(mode, cursor)
          : mode === "poll"
            ? polled(cursor)
            : reconnecting(transport.stream, cursor, mode === "stream" ? undefined : polled),
      ),
    ).pipe(
      Stream.rechunk(1),
      Stream.mapEffect(handled),
      // Why: A failure is pulled as the next element is, after the consumer handled the last.
      Stream.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Stream.failCause(cause)
          : Stream.concat(Stream.fromEffectDrain(keep(pending)), Stream.failCause(cause)),
      ),
      Stream.flattenIterable,
    );
  });

// Why: A watch holds what its receiver accepted until its consumer reads it, so a consumer
// behind by this many has the next POST answered 503, which the server retries, rather than
// the watch holding more.
const capacity = 16;

// Why: Unsubscribing is cleanup the server's expiry does anyway, so a server that does not
// answer delays a watch's end by this much at most.
const unsubscribeTimeout = Duration.seconds(5);

/**
 * One webhook subscription from `cursor`, read from `received`, where its receiver puts each
 * body: each grant, the subscribe's and each refresh's when half of it is left, is put there too,
 * behind what was accepted before it, so its position is kept in order; a refresh's failure is
 * put there as well, and ends the run where it is read.
 */
const delivered = <E, R>(
  webhook: WebhookTransport<E, R>,
  request: Omit<WebhookRequest, "cursor">,
  received: Queue.Queue<Effect.Effect<ReadonlyArray<Fed>, E>>,
  cursor: string | null,
): Stream.Stream<Fed, E, R> => {
  let at = cursor;

  const subscribed = Effect.suspend(() => webhook.subscribe({ ...request, cursor: at })).pipe(
    Effect.tap((grant) =>
      Queue.offer(
        received,
        Effect.succeed([
          grant.truncated
            ? Gap.make({ cursor: grant.cursor })
            : Checked.make({ cursor: grant.cursor }),
        ]),
      ),
    ),
  );

  const refreshed = (refreshBefore: string | null): Effect.Effect<never, E, R> =>
    refreshBefore === null
      ? Effect.never
      : Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Effect.andThen(
            Effect.sleep(Duration.millis(Math.max(0, (Date.parse(refreshBefore) - now) / 2))),
            Effect.flatMap(subscribed, (grant) => refreshed(grant.refreshBefore)),
          ),
        );

  return Stream.unwrap(
    Effect.gen(function* () {
      const grant = yield* subscribed;

      yield* Effect.forkScoped(
        Effect.catchCause(refreshed(grant.refreshBefore), (cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Queue.offer(received, Effect.failCause(cause)),
        ),
      );

      return Stream.fromEffectRepeat(Effect.flatten(Queue.take(received))).pipe(
        Stream.flattenIterable,
        Stream.tap((fed) =>
          Effect.sync(() => {
            at = fed.cursor ?? at;
          }),
        ),
      );
    }),
  );
};

/**
 * The arguments of `watch(event, ...)` after the event: its input, which may be left out when
 * `{}` is a valid encoded input, as for an action's call, and the watch's options `O`, whose
 * `resume` store may fail with `SE`.
 */
export type WatchArgs<
  E extends Event.Any,
  SE,
  O extends Event.WatchOptions<unknown> = Event.WatchOptions<SE>,
> = {} extends E["input"]["Encoded"]
  ? [input?: E["input"]["Type"], options?: O & Event.WatchOptions<SE>]
  : [input: E["input"]["Type"], options?: O & Event.WatchOptions<SE>];

/**
 * What a watch given the options `O` requires beyond its client's: the receiver, where its `mode`
 * may be a `Webhook.delivery`.
 */
export type WatchRequirement<O> = O extends { readonly mode?: infer M }
  ? [Extract<M, Event.WebhookDelivery>] extends [never]
    ? never
    : Receiving
  : never;
