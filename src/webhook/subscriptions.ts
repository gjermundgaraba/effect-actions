import {
  Cause,
  Clock,
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  Match,
  Option,
  RcMap,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  Stream,
  Struct,
} from "effect";
import { type HttpClient, HttpRouter, HttpServerRequest } from "effect/http";
import type { Dns } from "effect/net";
import { Anyone, type Keyed } from "../contract/caller.js";
import * as Event from "../contract/Event.js";
import { canonicalInput, type Feed } from "../contract/feed.js";
import { encodeUntaggedOf } from "../contract/occurrence.js";
import { type Pushed, pushed, refusalIn } from "../contract/push.js";
import { reported } from "../contract/reported.js";
import {
  type DeliveryStatus,
  secretKey,
  type Subscribed,
  type Subscribing,
  type Subscription,
  terminationError,
  type Webhooks,
} from "../contract/webhooks.js";
import { checkedHost } from "./address.js";
import { type AttemptFailed, attempt, challenged, type Posting } from "./attempt.js";
import { constantTimeEqual, randomToken, subscriptionId } from "./signing.js";
import type { Storage, Stored } from "./stored.js";

/** How `Webhook.layer` grants, verifies and retries, each with its default resolved. */
export interface Policy {
  readonly maxTtl: Duration.Duration;
  readonly allowedCallbacks: ReadonlyArray<URL>;
  readonly retryFor: Duration.Duration;
  /** Where subscriptions are kept past a restart, with `persist`. */
  readonly storage: Storage | undefined;
  /** What resolves a callback's name for its address check, unless `resolveCallbacks` is `false`. */
  readonly dns: Dns.Dns["Service"] | undefined;
}

const minTtl = Duration.minutes(1);

const rotationGrace = Duration.minutes(5);

const maxBody = 256 * 1024;

const encoder = new TextEncoder();

// Why: A `terminated` envelope ends a subscription no refresh can resume, so it is tried a few
// times, a second apart and doubling, and then given up, never suspended.
const lastAttempts = Schedule.exponential(Duration.seconds(1)).pipe(Schedule.upTo({ times: 3 }));

/** One webhook subscription as the layer holds it, its mutable parts replaced by a refresh. */
interface Held {
  readonly id: string;
  readonly url: URL;
  readonly feed: Feed;
  readonly verifiedAs: string;
  kept: Pick<Stored, "principal" | "input" | "identity">;
  secret: string;
  key: Uint8Array;
  previous: { readonly key: Uint8Array; readonly until: number } | undefined;
  context: Context.Context<unknown>;
  expiresAt: number;
  status: DeliveryStatus;
  watermark: string | null;
}

interface Confirmed {
  readonly cursor: string | null;
  readonly truncated: boolean;
}

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

// Why: A refresh resumes a suspended subscription with a fresh `retryFor`, as its failures are
// timed from `failedSince`; one still delivering keeps the budget its failures began.
const active = (status: DeliveryStatus): DeliveryStatus =>
  status.active ? status : { ...Struct.omit(status, ["failedSince"]), active: true };

// Why: Every grant expires, `ttlMs: null` granted `maxTtl` as an omitted one is, so a
// subscription whose subscriber is gone, suspended or not, ends at its grant, never held for good.
const grantOf = (ttlMs: number | null | undefined, policy: Policy) =>
  Duration.clamp(ttlMs === null || ttlMs === undefined ? policy.maxTtl : Duration.millis(ttlMs), {
    minimum: minTtl,
    maximum: policy.maxTtl,
  });

const trusted = (url: URL, prefixes: ReadonlyArray<URL>) =>
  prefixes.some(
    ({ origin, pathname }) =>
      url.origin === origin &&
      (url.pathname === pathname ||
        url.pathname.startsWith(pathname.endsWith("/") ? pathname : `${pathname}/`)),
  );

// Why: A delivery runs as its subscriber, in the subscribe request's context, but not in the
// request itself: its `Scope` closes with the response, and its HTTP request, credential
// included, would otherwise be held for the whole grant. An authorizer or a source reading the
// request finds none in a delivery, a gotcha on `Webhook.layer`.
const snapshotOf = Context.omit(
  Scope.Scope,
  HttpServerRequest.HttpServerRequest,
  HttpServerRequest.ParsedSearchParams,
  HttpRouter.RouteContext,
);

const undecoded = Effect.die(
  new Error(
    "A webhook subscription reached Webhooks undecoded (decode its url as CallbackUrl and its secret as WebhookSecret)",
  ),
);

const unserved = Effect.die(
  new Error(
    "A webhook subscription reached Webhooks before its surface served its event (serve each feed as the surface builds)",
  ),
);

const unreadable = Effect.die(
  new Error("A kept webhook subscription has an unreadable url or secret (remove its record)"),
);

const unencoded = Effect.die(
  new Error(
    "A webhook subscriber's identity did not encode by its authentication's schema (give Authentication.make a schema that encodes every identity its verifier provides)",
  ),
);

/**
 * The webhook subscriptions of one `Webhook.layer`: each a worker reading its feed as the
 * subscriber and POSTing what it reads to the callback, until it expires, is unsubscribed, or
 * is refused.
 */
export const makeWebhooks = (
  policy: Policy,
): Effect.Effect<Webhooks["Service"], never, Scope.Scope | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const built = yield* Effect.context<HttpClient.HttpClient>();
    const workers = yield* FiberMap.make<string>();
    const held = new Map<string, Held>();

    const served = new Map<
      string,
      { readonly event: Event.Any; readonly schema: Keyed["schema"] }
    >();

    const { storage } = policy;

    const holds = (subscription: Held) => held.get(subscription.id) === subscription;

    // Why: Only the subscription a layer holds now is kept: an old worker's last write, after its
    // end or its replacement's start, would bring back what was removed.
    const kept = (subscription: Held) =>
      Effect.sync(() => {
        if (storage !== undefined && holds(subscription))
          storage.mark(subscription.id, {
            ...subscription.kept,
            url: subscription.url.href,
            event: subscription.feed.event.name,
            secret: subscription.secret,
            expiresAt: subscription.expiresAt,
            watermark: subscription.watermark,
            status: subscription.status,
          });
      });

    const dropped = (id: string) => Effect.sync(() => storage?.mark(id, undefined));
    const verified = new Map<string, number>();
    const locks = yield* RcMap.make({ lookup: (_id: string) => Semaphore.make(1) });

    const retryForMillis = Duration.toMillis(policy.retryFor);

    // Why: A delivery's backoff and budget are measured from its subscription's `failedSince`,
    // kept with it, so a worker started again, after a restart or a Durable Object's wake, goes
    // on where the last stopped rather than from its first wait: it waits as long as the
    // subscription has been failing, from 1 second to 5 minutes, which doubles each wait, and
    // gives up `retryFor` after the failures began.
    const failingFor = ({ status }: Held) =>
      Effect.map(Clock.currentTimeMillis, (now) =>
        status.failedSince === undefined ? 0 : now - Date.parse(status.failedSince),
      );

    const retrying = (subscription: Held) => ({
      schedule: Schedule.modifyDelay(Schedule.forever, () =>
        Effect.map(failingFor(subscription), (failing) =>
          Duration.clamp(Duration.millis(failing), {
            minimum: Duration.seconds(1),
            maximum: Duration.minutes(5),
          }),
        ),
      ),
      while: (failure: AttemptFailed) =>
        failure.final
          ? Effect.succeed(false)
          : Effect.map(failingFor(subscription), (failing) => failing < retryForMillis),
    });

    const locked =
      (id: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.scoped(Effect.flatMap(RcMap.get(locks, id), (lock) => lock.withPermits(1)(effect)));

    // Why: The subscriber's context replaces the one an effect runs in, where `provideContext`
    // would merge it: the worker is forked from the subscribe request, whose services it would
    // otherwise keep.
    const asSubscriber = <A, E>(subscription: Held, effect: Effect.Effect<A, E, unknown>) =>
      Effect.updateContext<A, E, unknown, never>(effect, () => subscription.context);

    // Why: A callback `allowedCallbacks` trusts skips the address check too, as SEP-3415 lets a
    // server configured to allow it deliver to an address not globally reachable.
    const posted = (posting: Posting) =>
      Effect.provideContext(
        attempt(
          posting,
          trusted(posting.url, policy.allowedCallbacks)
            ? Effect.void
            : checkedHost(posting.url, policy.dns),
        ),
        built,
      );

    const post = (subscription: Held, webhookId: string, body: string) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        posted({
          url: subscription.url,
          subscriptionId: subscription.id,
          webhookId,
          body,
          keys:
            subscription.previous !== undefined && now < subscription.previous.until
              ? [subscription.key, subscription.previous.key]
              : [subscription.key],
        }),
      );

    const recorded = (subscription: Held, failure: AttemptFailed | undefined) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Effect.suspend(() => {
          const { status } = subscription;

          subscription.status =
            failure === undefined
              ? { active: true, lastDeliveryAt: iso(now), lastError: null }
              : {
                  ...status,
                  lastError: failure.category,
                  failedSince: status.failedSince ?? iso(now),
                };

          return failure !== undefined &&
            status.lastError === failure.category &&
            status.failedSince !== undefined
            ? Effect.void
            : kept(subscription);
        }),
      );

    const suspended = (subscription: Held) =>
      Effect.andThen(
        Effect.andThen(
          Effect.sync(() => {
            subscription.status = { ...subscription.status, active: false };
          }),
          kept(subscription),
        ),
        Effect.never,
      );

    // Why: A delivery abandoned at a `410` or a `413` ends the failures its budget is timed from:
    // left set, the next delivery's first transient failure, however much later, would find the
    // budget spent and suspend the subscription with no retry.
    const abandoned = (subscription: Held) =>
      Effect.andThen(
        Effect.sync(() => {
          subscription.status = Struct.omit(subscription.status, ["failedSince"]);
        }),
        kept(subscription),
      );

    // Why: Each delivery is retried apart, with a fresh timestamp and signature, backing off to 5
    // minutes, for `retryFor`; then, as SEP-3415 bounds retries, the subscription suspends until
    // a refresh, whose worker starts again from the watermark, before the delivery it gave up. A
    // `410` or a `413` abandons a delivery at once, so the worker reads on past it: answered
    // `false` for `delivered`, which leaves the subscriber a gap in its place.
    const delivered = (subscription: Held, webhookId: string, body: string) =>
      post(subscription, webhookId, body).pipe(
        Effect.tapError((failure) => recorded(subscription, failure)),
        Effect.retry(retrying(subscription)),
        Effect.matchEffect({
          onSuccess: () => Effect.as(recorded(subscription, undefined), true),
          onFailure: (failure) =>
            failure.final ? Effect.as(abandoned(subscription), false) : suspended(subscription),
        }),
      );

    const gapped = (subscription: Held, cursor: string | null) =>
      Effect.flatMap(randomToken(), (token) =>
        delivered(subscription, `msg_gap_${token}`, JSON.stringify({ type: "gap", cursor })),
      );

    // Why: Deliveries are serial, each acknowledged or abandoned before the next is read, so the
    // position a delivery or a refresh carries is safe to resume from with no bookkeeping of
    // deliveries in flight: `pushed` sends positions in order with the occurrences before them.
    // An admission failing with no refusal fails the read, which `pushed` reports and resumes
    // from before that occurrence, as it does a source's failure; one whose body is over 256 KiB
    // is given up, a gap the subscriber is told of once, and the worker reads on past it.
    const deliverTo = (subscription: Held, confirmation: Deferred.Deferred<Confirmed, unknown>) => {
      const encode = encodeUntaggedOf(subscription.feed.event);

      const moved = (cursor: string | null) =>
        cursor === null || cursor === subscription.watermark
          ? Effect.void
          : Effect.andThen(
              Effect.sync(() => {
                subscription.watermark = cursor;
              }),
              kept(subscription),
            );

      const confirmed = (cursor: string | null, truncated: boolean) =>
        Effect.andThen(moved(cursor), Deferred.succeed(confirmation, { cursor, truncated }));

      const skipped = (cursor: string | null) =>
        Effect.andThen(gapped(subscription, cursor), moved(cursor));

      return (sent: Pushed): Effect.Effect<void, unknown> =>
        Match.valueTags(sent, {
          Checked: ({ cursor }) =>
            Deferred.isDoneUnsafe(confirmation) ? moved(cursor) : confirmed(cursor, false),
          Gap: ({ cursor }) =>
            Deferred.isDoneUnsafe(confirmation) ? skipped(cursor) : confirmed(cursor, true),
          Occurrence: (occurrence) =>
            Effect.gen(function* () {
              const body = yield* asSubscriber(subscription, subscription.feed.admit).pipe(
                Effect.andThen(Effect.map(encode(occurrence), JSON.stringify)),
              );

              if (encoder.encode(body).length > maxBody) {
                yield* Effect.logWarning(
                  `Webhook delivery of ${occurrence.eventId} abandoned: its body is over 256 KiB`,
                );

                return yield* skipped(occurrence.cursor);
              }

              if (yield* delivered(subscription, occurrence.eventId, body))
                return yield* moved(occurrence.cursor);

              return yield* skipped(occurrence.cursor);
            }),
          Failed: () => Effect.void,
        });
    };

    const expired = ({ expiresAt }: Held): Effect.Effect<void> =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Effect.sleep(Duration.millis(Math.max(expiresAt - now, 0))),
      );

    const terminated = (subscription: Held, cause: Cause.Cause<unknown>) => {
      const refusal = refusalIn(cause);

      return refusal === undefined
        ? Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : reported(cause)
        : Effect.flatMap(randomToken(), (token) =>
            post(
              subscription,
              `msg_terminated_${token}`,
              JSON.stringify({ type: "terminated", error: terminationError(refusal) }),
            ).pipe(
              Effect.retry({ schedule: lastAttempts, while: (failure) => !failure.final }),
              Effect.ignore,
            ),
          );
    };

    const ended = (subscription: Held) =>
      Effect.sync(() => {
        if (holds(subscription)) held.delete(subscription.id);
      });

    // Why: A worker that ends of itself, expired, refused or failed, is removed from the store;
    // one interrupted, by an unsubscribe, which removes it, or by the layer closing, stays kept.
    const finished = (subscription: Held) =>
      Effect.suspend(() =>
        holds(subscription)
          ? Effect.andThen(ended(subscription), dropped(subscription.id))
          : Effect.void,
      );

    // Why: The end is handled after the read, where it can be interrupted: a `terminated`
    // envelope to a failing callback must hold up neither the layer's shutdown nor a new worker
    // for the same subscription, as it would from a finalizer. Each read is admitted afresh,
    // where a surface's stream is admitted once: a webhook outlives its request, so an authorizer
    // failing with no refusal, as at a restore or a refresh, is retried with the read, and only a
    // refusal, an expiry or an unsubscribe ends a subscription.
    const workerOf = (
      subscription: Held,
      input: Event.Any["input"]["Type"],
      cursor: string | null,
      confirmation: Deferred.Deferred<Confirmed, unknown>,
    ) =>
      Effect.raceFirst(
        pushed(
          (from) =>
            Stream.unwrap(Effect.map(subscription.feed.stream(input), (read) => read(from))),
          cursor,
          deliverTo(subscription, confirmation),
          { inOrder: true, resumesUnconfirmed: Deferred.isDoneUnsafe(confirmation) },
        ),
        expired(subscription),
      ).pipe(
        Effect.exit,
        Effect.tap(() => finished(subscription)),
        Effect.flatMap((exit) =>
          Deferred.isDoneUnsafe(confirmation)
            ? Exit.isFailure(exit)
              ? terminated(subscription, exit.cause)
              : Effect.void
            : Exit.isFailure(exit)
              ? Deferred.failCause(confirmation, exit.cause)
              : Deferred.succeed(confirmation, { cursor, truncated: false }),
        ),
        Effect.onInterrupt(() =>
          Effect.andThen(ended(subscription), Deferred.interrupt(confirmation)),
        ),
        (worker) => asSubscriber(subscription, worker),
      );

    const confirmedAt = (cursor: string | null) =>
      Effect.tap(Deferred.make<Confirmed, unknown>(), (confirmation) =>
        Deferred.succeed(confirmation, { cursor, truncated: false }),
      );

    const failedCallback = (feed: Feed, category: Event.CallbackCategory) =>
      Event.SubscriptionError.of(feed.event.name, new Event.CallbackFailed({ category }));

    // Why: A verified callback stays verified for as long as a subscription to it is granted, as
    // SEP-3415's soft state; entries past it are dropped as another is kept.
    const remembered = (verifiedAs: string, until: number, now: number) =>
      Effect.sync(() => {
        for (const [each, expiry] of verified) if (expiry <= now) verified.delete(each);

        verified.set(verifiedAs, Math.max(until, verified.get(verifiedAs) ?? 0));
      });

    const verify = (
      verifiedAs: string,
      url: URL,
      id: string,
      key: Uint8Array,
      feed: Feed,
      now: number,
    ) => {
      if ((verified.get(verifiedAs) ?? 0) > now || trusted(url, policy.allowedCallbacks))
        return Effect.void;

      return Effect.gen(function* () {
        const challenge = yield* randomToken();

        const echoed = yield* Effect.provideContext(
          challenged(
            {
              url,
              subscriptionId: id,
              webhookId: `msg_verification_${yield* randomToken()}`,
              body: JSON.stringify({ type: "verification", challenge }),
              keys: [key],
            },
            checkedHost(url, policy.dns),
          ),
          built,
        ).pipe(Effect.mapError(({ category }) => failedCallback(feed, category)));

        if (echoed === undefined || !constantTimeEqual(echoed, challenge))
          return yield* failedCallback(feed, "challenge_failed");
      });
    };

    // Why: The callback is named by its URL as parsed, as it is kept: by the string given, a
    // spelling parsing changes, such as an explicit default port, names another subscription
    // once it is restored.
    const idOf = ({ feed, principal, input, url }: Subscription) =>
      Effect.flatMap(canonicalInput(feed.event, input), (encoded) =>
        subscriptionId(
          `${principal}\u0000${URL.parse(url)?.href ?? url}\u0000${feed.event.name}\u0000${encoded}`,
        ),
      );

    // Why: A worker replacing another, at a refresh, a subscribe after expiry, an unsubscribe or a
    // refusal, starts by awaiting the old one's end, its `subscription` hook released, so the two
    // never hold the hook at once, and the request starting it waits for neither. What the layer
    // holds and its worker change in one uninterruptible step, so a request cancelled meanwhile
    // leaves the old pair or the new one, never a subscription held with no worker.
    const handover = (
      id: string,
      next: Held | undefined,
      worker: Effect.Effect<void, unknown, unknown>,
    ) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const previous = yield* FiberMap.get(workers, id);

          if (next === undefined) held.delete(id);
          else held.set(id, next);

          yield* FiberMap.run(
            workers,
            id,
            Option.match(previous, {
              onNone: () => worker,
              onSome: (fiber) => Effect.andThen(Fiber.await(fiber), worker),
            }),
          );
        }),
      );

    // Why: A refresh replaces the subscriber's snapshot, its identity included, so its worker
    // starts again under it, from the watermark: one running as the first subscriber would read
    // the source as them for as long as they refresh. A grant shortened ends the new worker at
    // its new deadline.
    const refreshed = (
      subscription: Held,
      secret: string,
      key: Uint8Array,
      context: Context.Context<unknown>,
      keptAs: Held["kept"],
      input: Event.Any["input"]["Type"],
      now: number,
      expiresAt: number,
    ) =>
      Effect.gen(function* () {
        const { status, watermark } = subscription;

        const renewed: Held = {
          ...subscription,
          ...(secret === subscription.secret
            ? {}
            : {
                secret,
                key,
                previous: { key: subscription.key, until: now + Duration.toMillis(rotationGrace) },
              }),
          context,
          kept: keptAs,
          expiresAt,
          status: active(status),
        };

        const confirmation = yield* confirmedAt(watermark);

        yield* handover(renewed.id, renewed, workerOf(renewed, input, watermark, confirmation));
        yield* remembered(renewed.verifiedAs, expiresAt, now);
        yield* kept(renewed);

        return {
          id: renewed.id,
          refreshBefore: iso(expiresAt),
          cursor: watermark,
          truncated: false,
          deliveryStatus: status,
        };
      });

    const heldOf = (
      fields: Pick<
        Held,
        | "id"
        | "url"
        | "feed"
        | "kept"
        | "secret"
        | "key"
        | "context"
        | "expiresAt"
        | "status"
        | "watermark"
      >,
    ): Held => ({
      ...fields,
      verifiedAs: `${fields.kept.principal}\u0000${fields.url.href}`,
      previous: undefined,
    });

    // Why: What a store keeps of a subscriber is its identity, the event's `caller`, by its
    // authentication's schema, encoded at each grant, so a restart restores the latest one.
    const keptOf = (feed: Feed, principal: string, input: Event.Any["input"]["Type"]) =>
      Effect.gen(function* () {
        const schema = served.get(feed.event.name)?.schema;

        if (storage === undefined || feed.event.caller === Anyone)
          return { principal, input: null, identity: null };

        if (schema === undefined) return yield* unserved;

        const identity = yield* Effect.service(feed.event.caller);

        return {
          principal,
          input: yield* Effect.orDie(
            Schema.encodeUnknownEffect(Schema.toCodecJson(feed.event.input))(input),
          ),
          identity: yield* Effect.catch(
            Schema.encodeUnknownEffect(Schema.toCodecJson(schema))(identity),
            () => unencoded,
          ),
        };
      });

    // Why: A restored subscription was confirmed before the restart, so its worker starts
    // confirmed: a refusal posts `terminated`, another failure is reported, and a source failing
    // its first read resumes. One suspended stays suspended, as SEP-3415 has a refresh alone resume
    // it, held until then or its expiry. Its id is derived again, so one whose input's canonical
    // form or subscriber's principal changed moves to the id its subscriber's next refresh names.
    const restoredFrom = (
      storage: Storage,
      feeds: ReadonlyArray<Feed>,
      keyed: Keyed | undefined,
      id: string,
    ) =>
      Effect.gen(function* () {
        const found = yield* storage.get(id);
        const record = Option.getOrUndefined(found);
        const feed = feeds.find(({ event }) => event.name === record?.event);

        if (record === undefined) return yield* dropped(id);

        if (feed === undefined || keyed?.schema === undefined) return;

        const { schema } = keyed;

        const { caller } = feed.event;
        const { expiresAt } = record;

        if (expiresAt <= (yield* Clock.currentTimeMillis) || caller === Anyone)
          return yield* dropped(id);

        const url = URL.parse(record.url);
        const key = Option.getOrUndefined(secretKey(record.secret));

        if (url === null || key === undefined) return yield* unreadable;

        const input = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(feed.event.input))(
          record.input,
        );

        const identity = yield* Schema.decodeUnknownEffect(Schema.toCodecJson(schema))(
          record.identity,
        );

        const principal = keyed.principal?.(identity) ?? record.principal;
        const current = yield* idOf({ feed, principal, input, url: url.href });

        if (current !== id) yield* dropped(id);

        if (held.has(current)) return;

        const subscription = heldOf({
          id: current,
          url,
          feed,
          kept: { principal, input: record.input, identity: record.identity },
          secret: record.secret,
          key,
          context: Context.add(built, caller, identity),
          expiresAt,
          status: record.status,
          watermark: record.watermark,
        });

        const confirmation = yield* confirmedAt(record.watermark);

        yield* handover(
          current,
          subscription,
          record.status.active
            ? workerOf(subscription, input, record.watermark, confirmation)
            : Effect.andThen(expired(subscription), finished(subscription)),
        );

        if (current !== id) yield* kept(subscription);
      }).pipe(Effect.catchCause(reported));

    const named = (feeds: ReadonlyArray<Feed>) =>
      feeds.map(({ event }) => `"${event.name}"`).join(", ");

    // Why: Each surface serves its feeds as it builds, MCP and HTTP alike, so restoring is
    // idempotent: a subscription held already, or of an event no surface serves, is left.
    const serve = (feeds: ReadonlyArray<Feed>, keyed: Keyed | undefined) =>
      Effect.gen(function* () {
        const twice = feeds.filter(
          ({ event }) => served.has(event.name) && served.get(event.name)?.schema !== keyed?.schema,
        );

        const namesake = feeds.filter(
          ({ event }) => served.has(event.name) && served.get(event.name)?.event !== event,
        );

        // Why: A subscription is keyed by its event's name, as SEP-3415's key is, so one layer
        // holding two event types of one name would refresh one's subscription for the other.
        if (namesake.length > 0)
          return yield* Effect.die(
            new Error(
              `Webhook.layer serves ${named(namesake)} for two event types of that name (give each event type a name of its own, or each surface its own Webhook.layer)`,
            ),
          );

        if (storage !== undefined && feeds.length > 0 && keyed?.schema === undefined)
          return yield* Effect.die(
            new Error(
              `Webhook.layer persists webhook subscriptions, but the authentication of ${named(feeds)} has no schema to keep a subscriber's identity by (give its Authentication.make a schema)`,
            ),
          );

        if (storage !== undefined && twice.length > 0)
          return yield* Effect.die(
            new Error(
              `Webhook.layer persists webhook subscriptions, but ${named(twice)} is served by two authentications with different schemas (serve each event with one authentication, or give them one schema)`,
            ),
          );

        for (const { event } of feeds) {
          served.set(event.name, { event, schema: keyed?.schema });
        }

        if (storage === undefined) return;

        for (const id of storage.ids())
          yield* locked(id)(
            Effect.suspend(() =>
              held.has(id) ? Effect.void : restoredFrom(storage, feeds, keyed, id),
            ),
          );
      });

    // Why: A refresh refused ends the subscription it names, as SEP-3415 ends one whose
    // authorization is revoked: its deliveries admit the snapshot of its last grant, which an
    // authorizer reading the identity would go on admitting. Its `terminated` envelope is POSTed
    // apart, so the refusal is answered at once.
    const refused = (id: string, cause: Cause.Cause<unknown>) =>
      Effect.gen(function* () {
        const existing = held.get(id);

        if (
          existing !== undefined &&
          refusalIn(cause) !== undefined &&
          (yield* Clock.currentTimeMillis) < existing.expiresAt
        ) {
          yield* handover(id, undefined, terminated(existing, cause));
          yield* dropped(id);
        }

        return yield* Effect.failCause(cause);
      });

    const subscribe = (subscribing: Subscribing): Effect.Effect<Subscribed, unknown, unknown> =>
      Effect.gen(function* () {
        const { feed, principal, input, secret, cursor, ttlMs } = subscribing;
        const url = URL.parse(subscribing.url);
        const key = Option.getOrUndefined(secretKey(secret));

        if (url === null || key === undefined) return yield* undecoded;

        const id = yield* idOf(subscribing);

        return yield* locked(id)(
          Effect.gen(function* () {
            yield* Effect.catchCause(feed.admit, (cause) => refused(id, cause));

            const now = yield* Clock.currentTimeMillis;
            const expiresAt = now + Duration.toMillis(grantOf(ttlMs, policy));
            const context = Context.merge(built, snapshotOf(yield* Effect.context<unknown>()));
            const keptAs = yield* keptOf(feed, principal, input);
            const existing = held.get(id);

            // Why: A subscription lapses at its grant, whether or not its worker has ended yet,
            // so a refresh at that instant subscribes afresh from its cursor, as after a restart.
            if (existing !== undefined && now < existing.expiresAt)
              return yield* refreshed(
                existing,
                secret,
                key,
                context,
                keptAs,
                input,
                now,
                expiresAt,
              );

            const subscription = heldOf({
              id,
              url,
              feed,
              kept: keptAs,
              secret,
              key,
              context,
              expiresAt,
              status: { active: true, lastDeliveryAt: null, lastError: null },
              watermark: cursor,
            });

            yield* verify(subscription.verifiedAs, url, id, key, feed, now);
            yield* remembered(subscription.verifiedAs, expiresAt, now);

            const confirmation = yield* Deferred.make<Confirmed, unknown>();

            yield* handover(id, subscription, workerOf(subscription, input, cursor, confirmation));

            const started = yield* Deferred.await(confirmation);

            yield* kept(subscription);

            return {
              id,
              refreshBefore: iso(expiresAt),
              cursor: started.cursor,
              truncated: started.truncated,
            };
          }),
        );
      });

    // Why: A kept subscription the layer does not hold, one that no longer decodes, is removed
    // by its subscriber's unsubscribe, the one request that names its id.
    const unsubscribe = (subscription: Subscription): Effect.Effect<void, unknown, unknown> =>
      Effect.flatMap(idOf(subscription), (id) =>
        locked(id)(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;

            if (now < (held.get(id)?.expiresAt ?? 0))
              return yield* Effect.andThen(handover(id, undefined, Effect.void), dropped(id));

            if (storage?.ids().includes(id) === true) return yield* dropped(id);

            return yield* Event.SubscriptionError.of(
              subscription.feed.event.name,
              new Event.NotSubscribed(),
            );
          }),
        ),
      );

    return { serve, subscribe, unsubscribe };
  });
