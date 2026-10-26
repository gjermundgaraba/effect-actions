import { Context, Effect, Option } from "effect";
import { Anyone, isNamed, type Keyed, type Named } from "./caller.js";
import * as Event from "./Event.js";
import type { Feed } from "./feed.js";
import type { AnyWebhookCancellation, AnyWebhookSubscription, Subscribed } from "./subscribe.js";

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
      feeds: ReadonlyArray<WebhookFeed>,
      keyed: Named,
    ) => Effect.Effect<void, never, unknown>;
    readonly subscribe: (subscribing: Subscribing) => Effect.Effect<Subscribed, unknown, unknown>;
    readonly unsubscribe: (subscription: Subscription) => Effect.Effect<void, unknown, unknown>;
  }
>()("effect-actions/Webhooks") {}

const isProtected = (event: Event.Any): event is Protected => event.caller !== Anyone;

// Why: SEP-3415 keys a webhook subscription by its subscriber's principal, so one signed out, or
// one no principal names, could be unsubscribed or have its secret replaced by anyone.
/** Whether a surface offers `event` by webhook: a protected event, its subscribers `keyed`. */
export const offersWebhook = (event: Event.Any, keyed: Keyed | undefined): event is Protected =>
  isProtected(event) && isNamed(keyed);

/**
 * Serves the feeds among `feeds` a surface offers by webhook, its subscribers `keyed`, to the
 * `Webhooks` it is given, as it builds: restoring their kept subscriptions, and dying where they
 * cannot be kept. Answers the service, where given, and those feeds.
 */
export const servedWebhooks = (
  feeds: ReadonlyArray<Feed>,
  keyed: Keyed | undefined,
): Effect.Effect<
  {
    readonly webhooks: Option.Option<Webhooks["Service"]>;
    readonly offered: ReadonlyArray<WebhookFeed>;
  },
  never,
  unknown
> =>
  Effect.gen(function* () {
    const webhooks = yield* Effect.serviceOption(Webhooks);
    const offered = feeds.filter((feed): feed is WebhookFeed => offersWebhook(feed.event, keyed));

    if (Option.isSome(webhooks) && isNamed(keyed)) yield* webhooks.value.serve(offered, keyed);

    return { webhooks, offered };
  });

/** The calling subscriber of a webhook request, its feed and authentication, and the service. */
export interface Subscriber extends Pick<Subscribing, "feed" | "keyed" | "principal"> {
  readonly webhooks: Webhooks["Service"];
}

/**
 * The webhook subscriber calling a subscribe or unsubscribe of `feed`'s event on a surface given
 * `webhooks`, its subscribers `keyed`; `Unsupported` where the surface does not offer it by
 * webhook.
 */
export const webhookSubscriber = (
  feed: Feed,
  keyed: Keyed | undefined,
  webhooks: Option.Option<Webhooks["Service"]>,
): Effect.Effect<Subscriber, Event.SubscriptionError, unknown> => {
  const { event } = feed;

  if (Option.isNone(webhooks) || !isNamed(keyed) || !isProtected(event))
    return Effect.fail(
      Event.SubscriptionError.of(
        event.name,
        new Event.Unsupported({ feature: "deliveryMode", value: "webhook" }),
      ),
    );

  const service = webhooks.value;

  return Effect.map(Effect.service(event.caller), (identity) => ({
    webhooks: service,
    feed: { ...feed, event },
    keyed,
    principal: keyed.principal(identity),
  }));
};
