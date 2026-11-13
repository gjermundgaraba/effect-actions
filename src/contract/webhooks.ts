import { Context, Effect, Option } from "effect";

import { Anyone, isNamed } from "./caller.js";
import type { Keyed, Named } from "./caller.js";
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
  readonly keyed: Named;
}

/**
 * Where a surface's webhook subscriptions are held and delivered from: `Webhook.layer` provides
 * it, and a surface offers webhook delivery only where it is. A surface `serve`s the feeds it
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
      keyed: Named
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

const isProtected = (event: Event.Any): event is Protected =>
  event.caller !== Anyone;

export const offersWebhook = (
  event: Event.Any,
  keyed: Keyed | undefined
): event is Protected => isProtected(event) && isNamed(keyed);

export const deliversByWebhook = (
  feed: Feed,
  keyed: Keyed | undefined
): feed is WebhookFeed =>
  feed.requestBound !== true && offersWebhook(feed.event, keyed);

/**
 * Where a surface sends `feed`'s webhook subscriptions: to the holder the feed names, a reached
 * entity, or else to the surface's own `Webhooks`; none where the event is not offered by webhook.
 */
export const webhookHolder = (
  feed: Feed,
  keyed: Keyed | undefined,
  webhooks: Option.Option<WebhookHolder>
): Option.Option<WebhookHolder> => {
  if (feed.webhook !== undefined && offersWebhook(feed.event, keyed)) {
    return Option.some(feed.webhook);
  }

  return deliversByWebhook(feed, keyed) ? webhooks : Option.none();
};

export const servedWebhooks = (
  feeds: readonly Feed[],
  keyed: Keyed | undefined
): Effect.Effect<
  { readonly webhooks: Option.Option<Webhooks["Service"]> },
  never,
  unknown
> =>
  Effect.gen(function* () {
    const webhooks = yield* Effect.serviceOption(Webhooks);

    if (Option.isSome(webhooks) && isNamed(keyed)) {
      yield* webhooks.value.serve(
        feeds.filter((feed) => deliversByWebhook(feed, keyed)),
        keyed
      );
    }

    return { webhooks };
  });

export interface Subscriber extends Pick<
  Subscribing,
  "feed" | "keyed" | "principal"
> {
  readonly webhooks: WebhookHolder;
}

export const webhookSubscriber = (
  feed: Feed,
  keyed: Keyed | undefined,
  webhooks: Option.Option<WebhookHolder>
): Effect.Effect<Subscriber, Event.SubscriptionError, unknown> => {
  const holder = webhookHolder(feed, keyed, webhooks);
  const { event } = feed;

  if (
    Option.isNone(holder) ||
    !isNamed(keyed) ||
    !offersWebhook(event, keyed)
  ) {
    return Effect.fail(deliveryUnsupported(event.name, "webhook"));
  }

  return Effect.map(Effect.service(event.caller), (identity) => ({
    webhooks: holder.value,
    feed: { ...feed, event },
    keyed,
    principal: keyed.principal(identity),
  }));
};

/** A surface's answers to a webhook subscribe and unsubscribe of `feed`, run as its subscriber. */
export const webhookAnswers = (
  feed: Feed,
  keyed: Keyed | undefined,
  webhooks: Option.Option<WebhookHolder>
) => {
  const served = webhookSubscriber(feed, keyed, webhooks);

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
 * The feeds of `events` a surface's layer serves, and the webhooks it offers, served: run as the
 * layer builds, dying where a protected event's subscription hook has no principal to key it by.
 */
export const servingFeeds = Effect.fnUntraced(function* (
  surface: string,
  events: readonly AnyEventImplementation[],
  keyed: Keyed | undefined
) {
  const feeds = yield* acquireFeeds(events);

  const unkeyed =
    keyed?.principal === undefined
      ? feeds.find(
          ({ event, release }) =>
            release !== undefined && event.caller !== Anyone
        )
      : undefined;

  if (unkeyed !== undefined) {
    return yield* Effect.die(
      new Error(
        `${surface} event "${unkeyed.event.name}" is protected and has a subscription hook, so its authentication needs principal to tell poll subscribers apart (give Authentication.make a principal, such as (user) => user.id)`
      )
    );
  }

  return { feeds, ...(yield* servedWebhooks(feeds, keyed)) };
});
