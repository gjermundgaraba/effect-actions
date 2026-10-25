import { Context, Effect, Option, Schema, type Scope, Struct } from "effect";
import { Anyone } from "./caller.js";
import { Forbidden, Refusal } from "./errors.js";
import * as Event from "./Event.js";
import type { Keyed } from "./caller.js";
import type { Feed } from "./feed.js";
import type { ErasedValue } from "./implementation.js";
import { Gap, untaggedOccurrenceOf } from "./occurrence.js";
import type { Fed } from "./pages.js";

/** A webhook's callback: an https URL, which each delivery is POSTed to. */
export const CallbackUrl = Schema.String.annotate({
  description: "The https URL each delivery is POSTed to.",
}).check(Schema.makeFilter((url) => URL.parse(url)?.protocol === "https:" || "an https URL"));

const secretPrefix = "whsec_";

const decodeBase64 = Schema.decodeUnknownOption(Schema.Uint8ArrayFromBase64);

/** The key of a Standard Webhooks secret: `whsec_` and the base64 of 24 to 64 bytes. */
export const secretKey = (secret: string): Option.Option<Uint8Array> =>
  secret.startsWith(secretPrefix)
    ? Option.filter(
        decodeBase64(secret.slice(secretPrefix.length)),
        (key) => key.length >= 24 && key.length <= 64,
      )
    : Option.none();

/** A webhook's signing secret, as Standard Webhooks writes one: `whsec_` and the base64 of 24 to 64 bytes. */
export const WebhookSecret = Schema.String.annotate({
  description: "whsec_ and the base64 of 24 to 64 random bytes, which signs each delivery.",
}).check(
  Schema.makeFilter(
    (secret) =>
      Option.isSome(secretKey(secret)) || "whsec_ and the base64 of 24 to 64 random bytes",
  ),
);

/**
 * How a webhook subscription's deliveries are going, as a refresh answers it: whether it is
 * delivering, when it last delivered, and the category of its last failure, since when it fails.
 */
export const DeliveryStatus = Schema.Struct({
  active: Schema.Boolean,
  lastDeliveryAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Event.CallbackCategory),
  failedSince: Schema.optional(Schema.String),
});

export type DeliveryStatus = typeof DeliveryStatus.Type;

/**
 * A webhook subscription's grant: its id, which each delivery's `X-MCP-Subscription-Id` carries,
 * when to refresh it by, the position it is safe to resume from, and whether delivery starts
 * later than the cursor asked.
 */
export const Subscribed = Schema.Struct({
  id: Schema.String,
  refreshBefore: Schema.NullOr(Schema.String),
  cursor: Schema.NullOr(Schema.String),
  truncated: Schema.Boolean,
  deliveryStatus: Schema.optional(DeliveryStatus),
});

export type Subscribed = typeof Subscribed.Type;

/** Which webhook subscription a request names: the subscriber, the event, its input, the URL. */
export interface Subscription {
  readonly feed: Feed;
  readonly principal: string;
  readonly input: ErasedValue;
  readonly url: string;
}

/**
 * A request to start or refresh a webhook subscription: its signing secret, the cursor to start
 * from, and the lifetime it suggests in milliseconds, `null` asking for none. The surface decoded
 * `url` as a `CallbackUrl` and `secret` as a `WebhookSecret`.
 */
export interface Subscribing extends Subscription {
  readonly secret: string;
  readonly cursor: string | null;
  readonly ttlMs?: number | null | undefined;
}

const encodeRefusal = Schema.encodeUnknownSync(Schema.toCodecJson(Refusal));

const decodeRefusal = Schema.decodeUnknownOption(Schema.toCodecJson(Refusal));

// Why: SEP-3415's error codes, provisional until it is accepted, pinned to the PR head
// 2ec39b9c49c583411b73cb460dea5f52b5c541a6. A subscription's request fails with them, and its
// termination, in every delivery mode, carries them.
/** The error codes SEP-3415 defines, each naming one reason. */
export const eventCodes = {
  notFound: -32023,
  forbidden: -32024,
  unsupported: -32026,
  callbackEndpoint: -32027,
} as const;

/**
 * The error SEP-3415 ends a subscription with, in every delivery mode, where its subscriber is
 * refused: `-32024`, the refusal's message, and the refusal as its data.
 */
export const terminationError = (refusal: Refusal) => ({
  code: eventCodes.forbidden,
  message: refusal.message,
  data: encodeRefusal(refusal),
});

/**
 * The refusal a SEP-3415 error carries, as `terminationError` writes one: its `data` decoded, or
 * `Forbidden` with its message where `data` is no refusal.
 */
export const refusalOf = (error: { readonly message: string; readonly data?: unknown }): Refusal =>
  Option.getOrElse(decodeRefusal(error.data), () => new Forbidden({ message: error.message }));

const decodeCallback = Schema.decodeUnknownOption(
  Schema.Struct({ reason: Event.CallbackCategory }),
);

const decodeKind = Schema.decodeUnknownOption(Schema.Struct({ kind: Schema.String }));

const decodeUnsupported = Schema.decodeUnknownOption(
  Schema.Struct({ feature: Schema.String, value: Schema.optional(Schema.String) }),
);


/**
 * What a SEP-3415 error of the event `name` names, as a subscription's request fails with one and
 * its termination carries one: a reason of `Event.SubscriptionError`, or the refusal; `undefined`
 * for a code SEP-3415 does not define, or one whose `data` does not say what it names.
 */
export const reasonOf = (
  name: string,
  error: { readonly code?: number | undefined; readonly message: string; readonly data?: unknown },
): Event.SubscriptionError | Refusal | undefined => {
  switch (error.code) {
    case eventCodes.notFound:
      return Event.SubscriptionError.of(
        name,
        Option.exists(decodeKind(error.data), ({ kind }) => kind === "subscription")
          ? new Event.NotSubscribed()
          : new Event.NotServed(),
      );
    case eventCodes.forbidden:
      return refusalOf(error);
    case eventCodes.unsupported:
      return Option.getOrUndefined(
        Option.map(decodeUnsupported(error.data), (unsupported) =>
          Event.SubscriptionError.of(name, new Event.Unsupported(unsupported)),
        ),
      );
    case eventCodes.callbackEndpoint:
      return Option.match(decodeCallback(error.data), {
        onNone: () => undefined,
        onSome: ({ reason }) =>
          Event.SubscriptionError.of(name, new Event.CallbackFailed({ category: reason })),
      });
    default:
      return undefined;
  }
};

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
      feeds: ReadonlyArray<Feed>,
      keyed: Keyed | undefined,
    ) => Effect.Effect<void, never, unknown>;
    readonly subscribe: (subscribing: Subscribing) => Effect.Effect<Subscribed, unknown, unknown>;
    readonly unsubscribe: (subscription: Subscription) => Effect.Effect<void, unknown, unknown>;
  }
>()("effect-actions/Webhooks") {}

// Why: SEP-3415 keys a webhook subscription by its subscriber's principal, so one signed out, or
// one no principal names, could be unsubscribed or have its secret replaced by anyone.
/** Whether a surface offers `event` by webhook: a protected event, its subscribers `keyed`. */
export const offersWebhook = (event: Event.Any, keyed: Keyed | undefined): boolean =>
  event.caller !== Anyone && keyed?.principal !== undefined;

/**
 * The webhook service and the calling subscriber's principal, for a subscribe or unsubscribe of
 * `event` on a surface given `webhooks`; `Unsupported` where the surface does not offer `event`
 * by webhook.
 */
export const webhookSubscriber = (
  event: Event.Any,
  keyed: Keyed | undefined,
  webhooks: Option.Option<Webhooks["Service"]>,
): Effect.Effect<
  { readonly webhooks: Webhooks["Service"]; readonly principal: string },
  Event.SubscriptionError,
  unknown
> => {
  const unsupported = Effect.fail(
    Event.SubscriptionError.of(
      event.name,
      new Event.Unsupported({ feature: "deliveryMode", value: "webhook" }),
    ),
  );

  return Option.isSome(webhooks) && event.caller !== Anyone
    ? Effect.flatMap(Effect.service(event.caller), (identity) => {
        const principal = keyed?.principal?.(identity);

        return principal === undefined
          ? unsupported
          : Effect.succeed({ webhooks: webhooks.value, principal });
      })
    : unsupported;
};

/** A POST a receiver verified, its JSON body: an occurrence, or an envelope. */
export type Delivered = { readonly [key: string]: Schema.Json };

/** The query parameter of a watch's delivery URL naming its place at the receiver. */
export const watchParameter = "watch";

/**
 * One watch's place at a receiver: the id its delivery URL names in `watchParameter`, and the
 * secret to subscribe with.
 */
export interface Registered {
  readonly id: string;
  readonly secret: string;
}

/**
 * Where a watch by webhook receives its deliveries in this process: `Webhook.layerReceiver`
 * provides it beside its route, and `register` keeps a watch's place for its scope, handing each
 * verified body to `deliver`, which answers `false` while the watch has no room for it.
 */
export class Receiving extends Context.Service<
  Receiving,
  {
    readonly register: (
      deliver: (body: Delivered) => boolean,
    ) => Effect.Effect<Registered, never, Scope.Scope>;
  }
>()("effect-actions/Receiving") {}

const Terminated = Schema.Struct({
  error: Schema.Struct({
    code: Schema.optional(Schema.Int),
    message: Schema.String,
    data: Schema.optional(Schema.Json),
  }),
});

const decodeTerminated = Schema.decodeUnknownOption(Terminated);

const decodeGap = Schema.decodeUnknownEffect(
  Schema.toCodecJson(Gap.mapFields(Struct.omit(["_tag"]))),
);

const ended = new Forbidden({ message: "The subscription was ended." });

/**
 * What a watch of `event` reads from one delivered body: its occurrence, or the gap an envelope
 * reports; a `terminated` envelope fails with the reason its error's code names, its refusal for
 * any other, an envelope of another type is skipped, and a body that does not decode fails with a
 * `SchemaError`.
 */
export const webhookFed = (event: Event.Any) => {
  const occurrenceOf = untaggedOccurrenceOf(event);

  return (
    body: Delivered,
  ): Effect.Effect<ReadonlyArray<Fed>, Event.SubscriptionError | Refusal | Schema.SchemaError> => {
    switch (body["type"]) {
      case undefined:
        return Effect.map(occurrenceOf(body), (occurrence) => [occurrence]);
      case "gap":
        return Effect.map(decodeGap(body), (fields) => [Gap.make(fields)]);
      case "terminated":
        return Effect.fail(
          Option.match(decodeTerminated(body), {
            onNone: () => ended,
            onSome: ({ error }) => reasonOf(event.name, error) ?? refusalOf(error),
          }),
        );
      default:
        return Effect.succeed([]);
    }
  };
};
