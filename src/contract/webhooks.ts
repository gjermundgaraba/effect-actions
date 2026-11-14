import { Context, Effect, Option } from "effect";

import { Anyone } from "./caller.js";
import type { Keyed } from "./caller.js";
import type * as Event from "./Event.js";
import { acquireFeeds } from "./feed.js";
import type { AnyEventImplementation, Feed } from "./feed.js";
import { deliveryUnsupported } from "./subscribe.js";
import type {
  AnyWebhookCancellation,
  AnyWebhookSubscription,
  Subscribed,
} from "./subscribe.js";

/** An event type a surface may offer by webhook: a protected one, its caller an identity. */
export type Protected = Event.Any & {
  readonly caller: Exclude<Event.Any["caller"], typeof Anyone>;
};

/** A feed a surface offers by webhook: one of a protected event type. */
export interface WebhookFeed extends Feed {
  readonly event: Protected;
}

/** Which webhook subscription a request names: the subscriber, the event, its input, the URL. */
export interface Subscription extends AnyWebhookCancellation {
  readonly feed: WebhookFeed;
  readonly principal: string;
}

/**
 * A request to start or refresh a webhook subscription, as its surface decoded it, `keyed` the
 * surface's authentication, whose `schema` keeps the subscriber's identity.
 */
export interface Subscribing extends AnyWebhookSubscription {
  readonly feed: WebhookFeed;
  readonly principal: string;
  readonly keyed: Keyed;
}

/**
 * Where a surface's webhook subscriptions are held and delivered from: `Webhook.layer` provides
 * it, and a surface offers webhook delivery of its own events only where it is, and of a
 * protected event `ActionEntity.reaching` serves, held by the entity reached, which refuses
 * a subscription as `Unsupported` where it holds no `Webhook.layer`. A surface `serve`s the feeds it
 * offers by webhook as it builds, with its authentication, which restores their kept
 * subscriptions, and dies where they cannot be kept. `subscribe` runs as the subscriber, whose
 * context each delivery runs in; it fails as the feed's admission does, or with
 * `Event.SubscriptionError`.
 */
export class Webhooks extends Context.Service<
  Webhooks,
  {
    readonly serve: (
      feeds: readonly WebhookFeed[],
      keyed: Keyed
    ) => Effect.Effect<void, never, unknown>;
    readonly subscribe: (
      subscribing: Subscribing
    ) => Effect.Effect<Subscribed, unknown, unknown>;
    readonly unsubscribe: (
      subscription: Subscription
    ) => Effect.Effect<void, unknown, unknown>;
  }
>()("effect-actions/Webhooks") {}

/** Subscribes and unsubscribes a feed's webhooks where they are held. */
export type WebhookHolder = Pick<
  Webhooks["Service"],
  "subscribe" | "unsubscribe"
>;

/** Whether a surface offers `event` by webhook: a protected one, its caller an identity. */
export const offersWebhook = (event: Event.Any): event is Protected =>
  event.caller !== Anyone;

const offeredByWebhook = (feed: Feed): feed is WebhookFeed =>
  offersWebhook(feed.event);

const deliversByWebhook = (feed: Feed): feed is WebhookFeed =>
  feed.webhook === undefined && offeredByWebhook(feed);

export interface Subscriber extends Pick<
  Subscribing,
  "feed" | "keyed" | "principal"
> {
  readonly webhooks: WebhookHolder;
}

/**
 * Who subscribes to `feed`'s webhooks, and where they are held: the holder the feed names, a
 * reached entity, or else the surface's own `Webhooks`; none where the event is not offered by
 * webhook. Its principal is read from the caller each time it runs.
 */
export const webhookSubscriber = (
  feed: Feed,
  keyed: Keyed | undefined,
  webhooks: Option.Option<WebhookHolder>
): Option.Option<Effect.Effect<Subscriber, never, unknown>> =>
  keyed !== undefined && offeredByWebhook(feed)
    ? Option.map(
        feed.webhook === undefined ? webhooks : Option.some(feed.webhook),
        (holder) =>
          Effect.map(Effect.service(feed.event.caller), (identity) => ({
            webhooks: holder,
            feed,
            keyed,
            principal: keyed.principal(identity),
          }))
      )
    : Option.none();

/** As `webhookSubscriber`, failing as `Unsupported` where the event is not offered by webhook. */
export const subscriberOf = (
  feed: Feed,
  keyed: Keyed | undefined,
  webhooks: Option.Option<WebhookHolder>
): Effect.Effect<Subscriber, Event.SubscriptionError, unknown> =>
  Option.getOrElse(webhookSubscriber(feed, keyed, webhooks), () =>
    Effect.fail(deliveryUnsupported(feed.event.name, "webhook"))
  );

/** A surface's answers to a webhook subscribe and unsubscribe of `feed`, run as its subscriber. */
export const webhookAnswers = (
  feed: Feed,
  keyed: Keyed | undefined,
  webhooks: Option.Option<WebhookHolder>
) => {
  const served = subscriberOf(feed, keyed, webhooks);

  return {
    subscribe: (payload: AnyWebhookSubscription) =>
      Effect.flatMap(served, ({ webhooks: holder, ...subscriber }) =>
        holder.subscribe({ ...payload, ...subscriber })
      ),
    unsubscribe: (payload: AnyWebhookCancellation) =>
      Effect.flatMap(
        served,
        ({ webhooks: holder, feed: subscribed, principal }) =>
          holder.unsubscribe({ ...payload, feed: subscribed, principal })
      ),
  };
};

/**
 * The feeds of `events` a surface's layer serves, and the `Webhooks` it offers them by: run as
 * the layer builds, which serves the webhooks it delivers itself and restores their kept
 * subscriptions.
 */
export const servingFeeds = Effect.fnUntraced(function* (
  events: readonly AnyEventImplementation[],
  keyed: Keyed | undefined
) {
  const feeds = yield* acquireFeeds(events);
  const webhooks = yield* Effect.serviceOption(Webhooks);
  const delivered = feeds.filter(deliversByWebhook);

  if (Option.isSome(webhooks) && keyed !== undefined) {
    yield* webhooks.value.serve(delivered, keyed);
  }

  return { feeds, webhooks };
});
