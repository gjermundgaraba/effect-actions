import {
  Cause,
  Clock,
  Duration,
  Effect,
  Predicate,
  Queue,
  Schedule,
  Schema,
  Stream,
} from "effect";

import { CallbackUrl } from "./callback.js";
import * as Event from "./Event.js";
import { Checked, Gap } from "./occurrence.js";
import { paged } from "./pages.js";
import type { Fed, Page } from "./pages.js";
import { watchParameter } from "./receiving.js";
import type { Delivered, Receiving } from "./receiving.js";
import { makeRecent } from "./recent.js";
import type {
  AnyWebhookCancellation,
  AnyWebhookSubscription,
  Subscribed,
} from "./subscribe.js";

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
    request: Omit<AnyWebhookCancellation, "input">
  ) => Effect.Effect<void, E, R>;
  readonly read: (body: Delivered) => Effect.Effect<readonly Fed[], E>;
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

const afterFailures = <E>(transient: (error: E) => boolean) =>
  Schedule.min([
    Schedule.exponential(reconnectDelay),
    Schedule.spaced(maxReconnectDelay),
  ]).pipe(
    Schedule.setInputType<E>(),
    Schedule.while(({ input }) => transient(input)),
    Schedule.tap(({ input, duration }) =>
      Effect.logWarning(
        `A watch reconnects in ${Duration.format(duration)} after a failure`,
        input
      )
    )
  );

const isSubscriptionError: Predicate.Refinement<
  unknown,
  Event.SubscriptionError
> = Schema.is(Event.SubscriptionError);

const pushRefused = Predicate.compose(
  isSubscriptionError,
  ({ reason }) =>
    Predicate.isTagged(reason, "Unsupported") &&
    reason.feature === "deliveryMode" &&
    reason.value === "push"
);

const dedupeWindow = 1000;

const capacity = 16;

const unsubscribeTimeout = Duration.seconds(5);

const delivered = <E, R>(
  webhook: WebhookTransport<E, R>,
  request: Omit<WebhookRequest, "cursor">,
  received: Queue.Queue<Effect.Effect<readonly Fed[], E>>,
  cursor: string | null
): Stream.Stream<Fed, E, R> => {
  let at = cursor;

  const subscribed = Effect.suspend(() =>
    webhook.subscribe({ ...request, cursor: at })
  ).pipe(
    Effect.tap((grant) =>
      Queue.offer(
        received,
        Effect.succeed([
          grant.truncated
            ? Gap.make({ cursor: grant.cursor })
            : Checked.make({ cursor: grant.cursor }),
        ])
      )
    )
  );

  const refreshed = (
    refreshBefore: string | null
  ): Effect.Effect<never, E, R> =>
    refreshBefore === null
      ? Effect.never
      : Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Effect.andThen(
            Effect.sleep(
              Duration.millis(
                Math.max(0, (Date.parse(refreshBefore) - now) / 2)
              )
            ),
            Effect.flatMap(subscribed, (grant) =>
              refreshed(grant.refreshBefore)
            )
          )
        );

  return Stream.unwrap(
    Effect.gen(function* () {
      const grant = yield* subscribed;

      yield* Effect.forkScoped(
        Effect.catchCause(refreshed(grant.refreshBefore), (cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Queue.offer(received, Effect.failCause(cause))
        )
      );

      return Stream.fromEffectRepeat(Effect.flatten(Queue.take(received))).pipe(
        Stream.flattenIterable,
        Stream.tap((fed) =>
          Effect.sync(() => {
            at = fed.cursor ?? at;
          })
        )
      );
    })
  );
};

export const watching = <E, R, SE = never>(
  transport: Transport<E, R>,
  { cursor: given, mode, resume }: Event.WatchOptions<SE> = {}
): Stream.Stream<
  Event.Received<Event.Any>,
  E | SE | Event.SubscriptionError | Schema.SchemaError,
  R
> => {
  const reconnecting = (
    open: (cursor: string | null) => Stream.Stream<Fed, E, R>,
    cursor: string | null,
    polled?: (cursor: string | null) => Stream.Stream<Fed, E, R>
  ): Stream.Stream<Fed, E, R> => {
    const { transient } = transport;
    let at = cursor;

    const once = Stream.suspend(() => open(at)).pipe(
      Stream.tap((fed) =>
        Effect.sync(() => {
          at = fed.cursor ?? at;
        })
      )
    );

    const reopened =
      transient === undefined
        ? once
        : once.pipe(
            Stream.repeat(Schedule.spaced(reconnectDelay)),
            Stream.retry(afterFailures(transient))
          );

    return polled === undefined
      ? reopened
      : reopened.pipe(
          Stream.catchIf(pushRefused, () => Stream.suspend(() => polled(at)))
        );
  };

  const polled = (cursor: string | null) =>
    reconnecting((at) => paged(transport.poll, at), cursor);

  const webhooked = (
    { baseUrl, ttl }: Event.WebhookDelivery,
    cursor: string | null
  ) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const { webhook } = transport;

        if (webhook === undefined) {
          return yield* Event.SubscriptionError.of(
            transport.name,
            new Event.Unsupported({
              feature: "deliveryMode",
              value: "webhook",
            })
          );
        }

        const base = yield* Schema.decodeEffect(CallbackUrl)(baseUrl);
        const receiving = yield* webhook.receiver;

        const received =
          yield* Queue.unbounded<Effect.Effect<readonly Fed[], E>>();

        const { id, secret } = yield* receiving.register(
          (body) =>
            Queue.sizeUnsafe(received) < capacity &&
            Queue.offerUnsafe(received, webhook.read(body))
        );

        const url = new URL(
          `${base.pathname.replace(/\/$/u, "")}${receiving.path}`,
          base
        );

        url.searchParams.set(watchParameter, id);

        const request = {
          delivery: { url, secret },
          ttlMs:
            ttl === undefined
              ? undefined
              : Duration.toMillis(Duration.fromInputUnsafe(ttl)),
        };

        yield* Effect.addFinalizer(() =>
          webhook
            .unsubscribe({ delivery: { url } })
            .pipe(Effect.timeout(unsubscribeTimeout), Effect.ignore)
        );

        return reconnecting(
          (at) => delivered(webhook, request, received, at),
          cursor
        );
      })
    );

  return Stream.suspend(() => {
    const seen = makeRecent(dedupeWindow);
    let keptOnNextPull: string | null = null;

    const keep = (cursor: string | null): Effect.Effect<void, SE> =>
      cursor === null || resume === undefined
        ? Effect.void
        : resume.store.set(resume.key, cursor);

    const fresh = (eventId: string) => {
      if (seen.has(eventId)) {
        return false;
      }

      seen.add(eventId);

      return true;
    };

    const handled = Effect.fnUntraced(function* (
      fed: Fed
    ): Effect.fn.Return<ReadonlyArray<Event.Received<Event.Any>>, SE> {
      yield* keep(keptOnNextPull);
      keptOnNextPull = null;

      if (Predicate.isTagged(fed, "Checked")) {
        yield* keep(fed.cursor);

        return [];
      }

      if (Predicate.isTagged(fed, "Gap")) {
        return [fed];
      }

      keptOnNextPull = fed.cursor;

      return fresh(fed.eventId) ? [fed] : [];
    });

    const start: Effect.Effect<string | null, SE> =
      given !== undefined || resume === undefined
        ? Effect.succeed(given ?? null)
        : Effect.map(resume.store.get(resume.key), (kept) => kept ?? null);

    return Stream.unwrap(
      Effect.map(start, (cursor) => {
        if (Predicate.isTagged(mode, "WebhookDelivery")) {
          return webhooked(mode, cursor);
        }

        if (mode === "poll") {
          return polled(cursor);
        }

        return reconnecting(
          transport.stream,
          cursor,
          mode === "stream" ? undefined : polled
        );
      })
    ).pipe(
      Stream.rechunk(1),
      Stream.mapEffect(handled),
      Stream.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Stream.failCause(cause)
          : Stream.concat(
              Stream.fromEffectDrain(keep(keptOnNextPull)),
              Stream.failCause(cause)
            )
      ),
      Stream.flattenIterable
    );
  });
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
