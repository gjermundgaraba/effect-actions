import { Duration, Effect, Layer, type Scope } from "effect";
import { type HttpClient, HttpRouter } from "effect/http";
import { Dns } from "effect/net";
import { KeyValueStore } from "effect/persistence";
import * as Event from "../contract/Event.js";
import { Receiving, Webhooks } from "../contract/webhooks.js";
import { makeReceiver } from "./receiver.js";
import { makeStorage, type Storage } from "./stored.js";
import { makeWebhooks } from "./subscriptions.js";

/** How `layer` grants, verifies and retries webhook subscriptions. */
export interface Options {
  /**
   * The longest lifetime a subscription is granted, and what one that suggests none, or asks for
   * no expiry with `ttlMs: null`, is granted. Defaults to 1 hour; a suggestion under 1 minute is
   * granted 1 minute. Finite, as every grant expires: `Duration.infinity` is refused as the layer
   * is made.
   */
  readonly maxTtl?: Duration.Input | undefined;
  /**
   * Callbacks trusted without the verification handshake or the address check, each an https
   * URL whose origin a callback has exactly and whose path it starts with, segment by segment:
   * `["https://hooks.example.com/"]`. A callback on a private network is delivered to only when
   * one of them trusts it.
   */
  readonly allowedCallbacks?: ReadonlyArray<string> | undefined;
  /**
   * How long a subscription's deliveries are retried from its first failure, each wait as long as
   * it has been failing, from 1 second to 5 minutes, before it suspends until its next refresh,
   * which delivers it again with a fresh `retryFor`. Defaults to 1 hour.
   *
   * **Gotchas**
   *
   * - The failures are timed from the subscription's `failedSince`, which `persist` keeps: a restart goes on with the waits and the budget it reached, and a refresh of a subscription still delivering does not extend it.
   */
  readonly retryFor?: Duration.Input | undefined;
  /**
   * Keep each subscription in the application's `KeyValueStore`, which the layer then needs, so
   * a restart goes on delivering from where it reached: each surface restores the subscriptions
   * of the events it serves as it builds.
   *
   * **Gotchas**
   *
   * - Each subscriber's identity is kept by its authentication's `schema`, encoded at each grant: a surface offering a protected event by webhook refuses to start without it, or where two authentications with different schemas serve one event.
   * - A restored delivery runs in the layer's context and that identity alone, until the subscriber's next refresh: an authorizer or a source reading a service middleware or the surface's layer provides fails, each read reported and retried every 5 seconds.
   * - A subscriber refused as its subscription is restored is POSTed `terminated`; an authorizer or a source failing its first read with no refusal is retried, as later.
   * - A subscription suspended stays suspended when restored, until its subscriber's refresh delivers again.
   * - Secrets and identities are kept as JSON, as given, so give the layer a store only the server reads.
   * - A kept subscription whose input or identity no longer decodes, as after a schema change, is reported at each build and never restored, until its subscriber unsubscribes it.
   * - A store whose index cannot be read as the layer builds fails the build; a write that fails later is reported and tried again with the next, and pending writes get 5 seconds when the layer closes.
   * - A callback's verification is not kept: a restored subscription delivers on, and a new one to the same callback after a restart is verified again.
   */
  readonly persist?: boolean | undefined;
  /**
   * Whether a callback's name is resolved through `Dns` for its address check. `false` checks a
   * literal address alone and leaves a name to the platform's egress, and the layer then needs no
   * `Dns`: for a host with no resolver of its own, such as Cloudflare Workers. Defaults to `true`.
   *
   * **Gotchas**
   *
   * - With `false`, a callback named for a private or loopback address is POSTed to wherever the platform's egress reaches: give it only where that egress reaches no network of yours.
   */
  readonly resolveCallbacks?: boolean | undefined;
}

const trustedOf = (prefix: string): URL => {
  const url = URL.parse(prefix);

  if (url?.protocol !== "https:")
    throw new Error(
      `Invalid allowedCallbacks entry: ${prefix} (give an https URL, such as https://hooks.example.com/)`,
    );

  return url;
};

// Why: every grant expires, so a subscription whose subscriber is gone ends at its grant: a
// `maxTtl` of no end would grant none, never ending one nobody refreshes.
const maxTtlOf = (input: Duration.Input): Duration.Duration => {
  const maxTtl = Duration.fromInputUnsafe(input);

  if (!Duration.isFinite(maxTtl))
    throw new Error(
      `Invalid maxTtl: ${Duration.format(maxTtl)} (every grant expires: give a finite duration, such as "1 hour")`,
    );

  return maxTtl;
};

/**
 * Webhook delivery for the MCP endpoints and HTTP routes it is provided to, as SEP-3415 defines
 * it: a subscriber names a callback URL and a secret, and each occurrence of a protected event
 * it may see is POSTed there, signed as Standard Webhooks signs, until the subscription expires,
 * is unsubscribed, or is refused. One layer holds the subscriptions of every surface it is
 * provided to, so a subscription made over MCP is the one HTTP refreshes. It needs an
 * `HttpClient` for the deliveries, `Dns` for the address check unless `resolveCallbacks` is
 * `false`, and with `persist` a `KeyValueStore`. Each POST carries the
 * headers `webhook-id`, `webhook-timestamp`, `webhook-signature` and `x-mcp-subscription-id`, and
 * one JSON body: an occurrence `{ eventId, name, timestamp, data, cursor }`, whose `webhook-id`
 * is its `eventId`, or an envelope, `{ type: "verification", challenge }` to echo,
 * `{ type: "gap", cursor }` where occurrences were missed, or `{ type: "terminated", error }`
 * where the subscription ended. Guide: `docs/Webhook.md` in this package.
 *
 * **Gotchas**
 *
 * - Only a protected event whose descriptor has `principal` is offered webhook delivery: elsewhere `events/list` lists no `webhook`, and a subscribe is `Unsupported`.
 * - A `requestScoped` MCP endpoint offers it too, its subscriptions built once with the endpoint: on a host with no lasting process, leave this layer out, as `ActionHttp.layer` says, since each instance keeps its own subscriptions, lost as it ends.
 * - A callback resolving to an address that is not globally reachable, a loopback or a private one included, is never POSTed to unless `allowedCallbacks` trusts it: a local receiver needs a public name, a trusted URL, or a test's `Dns.layerStatic`; an IPv6-only server behind NAT64 cannot deliver to an IPv4-only callback.
 * - Each POST is checked against the address it resolves to, but fetch connects to the name again, so a name rebinding between the check and the connection is not caught: front the server with an egress proxy that refuses private addresses where that matters.
 * - Deliveries run with fetch's `redirect: "manual"`, and a 3xx answer is a failed attempt; an `HttpClient` that is not fetch's follows redirects as it does.
 * - A failed attempt's category is `connection_refused` for any transport failure, never `tls_error`, which no platform client reports apart.
 * - A delivery's 2xx answer is a success, its body never read; a verification's answer is read as far as 4 KiB, and one longer fails its challenge.
 * - A callback verified for a subscriber is not challenged again for that subscriber's other subscriptions to it while one is granted, as SEP-3415's soft state allows.
 * - Deliveries are one at a time, in order: one failing holds back those after it, for `retryFor`, then the subscription suspends until a refresh, which delivers it again.
 * - An occurrence given up, its body over 256 KiB or its POST answered `410` or `413`, is POSTed as a `gap` at its cursor; one whose admission fails with no refusal is reported and read again, from before it, every 5 seconds.
 * - A refresh restarts its subscription's reading under the refreshed subscriber, from where delivery reached: the subscription hook set up again once the old one is released, and a delivery in flight sent again, which the subscriber drops by its `eventId`.
 * - A refresh its authorizer refuses ends the subscription it names, POSTing `terminated`, though each delivery, admitted as the subscriber of the last grant, would still pass.
 * - A refresh with a new secret signs each POST with both secrets for 5 minutes, `webhook-signature` holding two, so a receiver may switch over; after that, with the new one alone.
 * - A delivery runs in the subscribe request's context without the request: an authorizer or a source reading `HttpServerRequest` fails in a delivery, so read what it needs in middleware, which provides it as a service.
 * - `allowedCallbacks` throws when `layer` is called for an entry that is not an https URL.
 */
export function layer(
  options: Options & { readonly persist?: false | undefined; readonly resolveCallbacks: false },
): Layer.Layer<Webhooks, never, HttpClient.HttpClient>;
export function layer(
  options: Options & { readonly resolveCallbacks: false },
): Layer.Layer<Webhooks, never, HttpClient.HttpClient | KeyValueStore.KeyValueStore>;
export function layer(
  options?: Options & { readonly persist?: false | undefined },
): Layer.Layer<Webhooks, never, HttpClient.HttpClient | Dns.Dns>;
export function layer(
  options: Options,
): Layer.Layer<Webhooks, never, HttpClient.HttpClient | Dns.Dns | KeyValueStore.KeyValueStore>;
export function layer(
  options: Options = {},
): Layer.Layer<Webhooks, never, HttpClient.HttpClient | Dns.Dns | KeyValueStore.KeyValueStore> {
  const allowedCallbacks = (options.allowedCallbacks ?? []).map(trustedOf);
  const maxTtl = maxTtlOf(options.maxTtl ?? "1 hour");

  const dns: Effect.Effect<Dns.Dns["Service"] | undefined, never, Dns.Dns> =
    options.resolveCallbacks === false ? Effect.succeed(undefined) : Effect.service(Dns.Dns);

  const storage: Effect.Effect<
    Storage | undefined,
    never,
    KeyValueStore.KeyValueStore | Scope.Scope
  > =
    options.persist === true
      ? Effect.flatMap(KeyValueStore.KeyValueStore, makeStorage)
      : Effect.succeed(undefined);

  return Layer.effect(
    Webhooks,
    Effect.flatMap(Effect.all([dns, storage]), ([resolver, kept]) =>
      makeWebhooks({
        maxTtl,
        allowedCallbacks,
        retryFor: Duration.fromInputUnsafe(options.retryFor ?? "1 hour"),
        storage: kept,
        dns: resolver,
      }),
    ),
  );
}

/** Where a watch by webhook asks the server to POST, and the lifetime each grant asks for. */
export type DeliveryOptions = ConstructorParameters<typeof Event.WebhookDelivery>[0];

/**
 * A watch's `mode` delivering by webhook: `client.watch(event, input, { mode:
 * Webhook.delivery({ url }) })` keeps a place at this process's `layerReceiver`, subscribes `url`
 * with that place's id and secret, reads what the server POSTs there, refreshes the subscription
 * when half its grant is left, also through a reconnect, and unsubscribes when the watch ends.
 * Over MCP and HTTP; elsewhere the watch fails with `Event.SubscriptionError`, reason
 * `Unsupported`.
 *
 * **Gotchas**
 *
 * - The watch needs `layerReceiver` provided to it, and its route served at `url`: without the layer it dies with a message naming it, and without the route the subscribe fails with `CallbackFailed`.
 * - A server refuses a callback that is not globally reachable, so `url` is a public name of this process, such as a tunnel's in development.
 * - The URL subscribed is `url` with a `watch` query parameter, one per watch, so watches never share a subscription: a proxy in front of the route must pass the query on.
 * - A restarted process subscribes afresh from the cursor `resume` kept, so the server sends again what the last process accepted and never handed on; the old subscription lapses at its grant, each delivery to it answered 410.
 */
export const delivery = (options: DeliveryOptions): Event.WebhookDelivery =>
  new Event.WebhookDelivery(options);

/** Where `layerReceiver` serves its route. */
export interface ReceiverOptions {
  /** The route's path, `/hooks/builds`: the path of each watch's `delivery` URL. */
  readonly path: `/${string}`;
}

/**
 * The receiving end of watches by webhook in this process: a `POST` route at `path`, and the
 * registry each watch keeps its place in, under an id its delivery URL names and a secret of its
 * own. Each POST is verified as Standard Webhooks signs it, against the secret of the watch it
 * names, its timestamp within 5 minutes, and handed to that watch; a verification is answered
 * with its challenge, and a `webhook-id` among the watch's last 1,000 is acknowledged and dropped. Build it once,
 * the watches given it as the route's layer is (`Layer.provideMerge`).
 * Guide: `docs/Webhook.md` in this package.
 *
 * **Gotchas**
 *
 * - A POST naming no watch of this receiver is a 410, which the server abandons without retrying: what is in flight to a watch that ended is not delivered, and its subscription lapses at its grant.
 * - A POST its watch's secret did not sign, or out of the timestamp window, is a 401; a signed body that is not a JSON object, a 400.
 * - A watch reads at its consumer's pace: 16 deliveries wait for it, and the next is answered 503, which the server retries.
 * - Two `layerReceiver` layers are two registries: a watch given one, its route served by the other, has its subscribe fail with `CallbackFailed`, every POST a 410.
 * - A body is read whole: limit it with `HttpServerRequest.MaxBodySize` where the route is served, as `ActionHttp.layer`'s gotcha says.
 */
export const layerReceiver = ({
  path,
}: ReceiverOptions): Layer.Layer<Receiving, never, HttpRouter.HttpRouter> =>
  Layer.unwrap(
    Effect.map(makeReceiver, ({ receiving, handler }) =>
      Layer.merge(Layer.succeed(Receiving, receiving), HttpRouter.add("POST", path, handler)),
    ),
  );
