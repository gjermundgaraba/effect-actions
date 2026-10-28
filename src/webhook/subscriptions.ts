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
import { HttpRouter, HttpServerRequest } from "effect/http";
import type { HttpClient } from "effect/http";
import type { Dns } from "effect/net";

import type { SigningSecret } from "../contract/callback.js";
import type { Keyed, Named } from "../contract/caller.js";
import { canonicalInput } from "../contract/canonical.js";
import type { Codec } from "../contract/codec.js";
import { sentError } from "../contract/codes.js";
import * as Event from "../contract/Event.js";
import { encodeUntaggedOf } from "../contract/occurrence.js";
import { pushed, refusalIn } from "../contract/push.js";
import type { Pushed } from "../contract/push.js";
import { reported } from "../contract/reported.js";
import type { DeliveryStatus, Subscribed } from "../contract/subscribe.js";
import type {
  Subscribing,
  Subscription,
  WebhookFeed,
  Webhooks,
} from "../contract/webhooks.js";
import { checkedHost } from "./address.js";
import { attempt, challenged } from "./attempt.js";
import type { AttemptFailed } from "./attempt.js";
import { randomToken, subscriptionId } from "./signing.js";
import type { Storage, Stored } from "./stored.js";

export interface Policy {
  readonly maxTtl: Duration.Duration;
  readonly allowedCallbacks: readonly URL[];
  readonly retryFor: Duration.Duration;
  readonly storage: Storage | undefined;
  readonly dns: Dns.Dns["Service"] | undefined;
}

const minTtl = Duration.minutes(1);

const rotationGrace = Duration.minutes(5);

const maxBody = 256 * 1024;

const encoder = new TextEncoder();

const terminatedEnvelopeRetries = Schedule.exponential(
  Duration.seconds(1)
).pipe(Schedule.upTo({ times: 3 }));

interface Held {
  readonly id: string;
  readonly url: URL;
  readonly feed: WebhookFeed;
  readonly principal: string;
  readonly verifiedAs: string;
  kept: Pick<Stored, "input" | "identity">;
  secret: SigningSecret;
  previous: { readonly key: Uint8Array; readonly until: number } | undefined;
  context: Context.Context<unknown>;
  expiresAt: number;
  status: DeliveryStatus;
  watermark: string | null;
}

type Granted = Pick<Held, "secret" | "context" | "kept" | "expiresAt">;

interface Confirmed {
  readonly cursor: string | null;
  readonly truncated: boolean;
}

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

const resumedWithFreshBudget = (status: DeliveryStatus): DeliveryStatus =>
  status.active
    ? status
    : { ...Struct.omit(status, ["failedSince"]), active: true };

const grantOf = (ttlMs: number | null | undefined, policy: Policy) =>
  Duration.clamp(
    ttlMs === null || ttlMs === undefined
      ? policy.maxTtl
      : Duration.millis(ttlMs),
    {
      minimum: minTtl,
      maximum: policy.maxTtl,
    }
  );

const trusted = (url: URL, prefixes: readonly URL[]) =>
  prefixes.some(
    ({ origin, pathname }) =>
      url.origin === origin &&
      (url.pathname === pathname ||
        url.pathname.startsWith(
          pathname.endsWith("/") ? pathname : `${pathname}/`
        ))
  );

const snapshotOf = Context.omit(
  Scope.Scope,
  HttpServerRequest.HttpServerRequest,
  HttpServerRequest.ParsedSearchParams,
  HttpRouter.RouteContext
);

const unencoded = Effect.die(
  new Error(
    "A webhook subscriber's identity did not encode by its authentication's schema (give Authentication.make a schema that encodes every identity its verifier provides)"
  )
);

const confirmedAt = (cursor: string | null) =>
  Effect.tap(Deferred.make<Confirmed, unknown>(), (confirmation) =>
    Deferred.succeed(confirmation, { cursor, truncated: false })
  );

const failedCallback = (feed: WebhookFeed, category: Event.CallbackCategory) =>
  Event.SubscriptionError.of(
    feed.event.name,
    new Event.CallbackFailed({ category })
  );

const idOf = ({ feed, principal, input, delivery: { url } }: Subscription) =>
  Effect.flatMap(canonicalInput(feed.event.input, input), (encoded) =>
    subscriptionId(
      `${principal}\u0000${url.href}\u0000${feed.event.name}\u0000${encoded}`
    )
  );

const named = (feeds: readonly WebhookFeed[]) =>
  feeds.map(({ event }) => `"${event.name}"`).join(", ");

export const makeWebhooks = (
  policy: Policy
): Effect.Effect<
  Webhooks["Service"],
  never,
  Scope.Scope | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const built = yield* Effect.context<HttpClient.HttpClient>();
    const workers = yield* FiberMap.make<string>();
    const held = new Map<string, Held>();

    const served = new Map<
      string,
      { readonly event: Event.Any; readonly schema: Keyed["schema"] }
    >();

    const { storage } = policy;

    const holds = (subscription: Held) =>
      held.get(subscription.id) === subscription;

    const kept = (subscription: Held) =>
      Effect.sync(() => {
        if (storage !== undefined && holds(subscription)) {
          storage.mark(subscription.id, {
            ...subscription.kept,
            url: subscription.url,
            event: subscription.feed.event.name,
            secret: subscription.secret,
            expiresAt: subscription.expiresAt,
            watermark: subscription.watermark,
            status: subscription.status,
          });
        }
      });

    const dropped = (id: string) =>
      Effect.sync(() => storage?.mark(id, undefined));

    const verified = new Map<string, number>();

    const locks = yield* RcMap.make({
      lookup: (_id: string) => Semaphore.make(1),
    });

    const retryForMillis = Duration.toMillis(policy.retryFor);

    const failingFor = ({ status }: Held) =>
      Effect.map(Clock.currentTimeMillis, (now) =>
        status.failedSince === undefined
          ? 0
          : now - Date.parse(status.failedSince)
      );

    const waitingAsLongAsFailing = (subscription: Held) =>
      Schedule.modifyDelay(Schedule.forever, () =>
        Effect.map(failingFor(subscription), (failing) =>
          Duration.clamp(Duration.millis(failing), {
            minimum: Duration.seconds(1),
            maximum: Duration.minutes(5),
          })
        )
      );

    const retrying = (subscription: Held) => ({
      schedule: waitingAsLongAsFailing(subscription),
      while: (failure: AttemptFailed) =>
        failure.final
          ? Effect.succeed(false)
          : Effect.map(
              failingFor(subscription),
              (failing) => failing < retryForMillis
            ),
    });

    const locked =
      (id: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.scoped(
          Effect.flatMap(RcMap.get(locks, id), (lock) =>
            lock.withPermits(1)(effect)
          )
        );

    const asSubscriber = <A, E>(
      subscription: Held,
      effect: Effect.Effect<A, E, unknown>
    ) =>
      Effect.updateContext<A, E, unknown, never>(
        effect,
        () => subscription.context
      );

    const post = (subscription: Held, webhookId: string, body: string) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Effect.provideContext(
          attempt(
            {
              url: subscription.url,
              subscriptionId: subscription.id,
              webhookId,
              body,
              keys:
                subscription.previous !== undefined &&
                now < subscription.previous.until
                  ? [subscription.secret.key, subscription.previous.key]
                  : [subscription.secret.key],
            },
            trusted(subscription.url, policy.allowedCallbacks)
              ? Effect.void
              : checkedHost(subscription.url, policy.dns)
          ),
          built
        )
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
        })
      );

    const suspended = (subscription: Held) =>
      Effect.andThen(
        Effect.andThen(
          Effect.sync(() => {
            subscription.status = { ...subscription.status, active: false };
          }),
          kept(subscription)
        ),
        Effect.never
      );

    const abandonedResettingBudget = (subscription: Held) =>
      Effect.andThen(
        Effect.sync(() => {
          subscription.status = Struct.omit(subscription.status, [
            "failedSince",
          ]);
        }),
        kept(subscription)
      );

    const delivered = (subscription: Held, webhookId: string, body: string) =>
      post(subscription, webhookId, body).pipe(
        Effect.tapError((failure) => recorded(subscription, failure)),
        Effect.retry(retrying(subscription)),
        Effect.matchEffect({
          onSuccess: () => Effect.as(recorded(subscription, undefined), true),
          onFailure: (failure) =>
            failure.final
              ? Effect.as(abandonedResettingBudget(subscription), false)
              : suspended(subscription),
        })
      );

    const gapped = (subscription: Held, cursor: string | null) =>
      Effect.flatMap(randomToken, (token) =>
        delivered(
          subscription,
          `msg_gap_${token}`,
          JSON.stringify({ type: "gap", cursor })
        )
      );

    const deliverTo = (
      subscription: Held,
      input: Event.Any["input"]["Type"],
      confirmation: Deferred.Deferred<Confirmed, unknown>
    ) => {
      const encode = encodeUntaggedOf(subscription.feed.event);

      const moved = (cursor: string | null) =>
        cursor === null || cursor === subscription.watermark
          ? Effect.void
          : Effect.andThen(
              Effect.sync(() => {
                subscription.watermark = cursor;
              }),
              kept(subscription)
            );

      const confirmed = (cursor: string | null, truncated: boolean) =>
        Effect.andThen(
          moved(cursor),
          Deferred.succeed(confirmation, { cursor, truncated })
        );

      const skipped = (cursor: string | null) =>
        Effect.andThen(gapped(subscription, cursor), moved(cursor));

      return (sent: Pushed): Effect.Effect<void, unknown> =>
        Match.valueTags(sent, {
          Checked: ({ cursor }) =>
            Deferred.isDoneUnsafe(confirmation)
              ? moved(cursor)
              : confirmed(cursor, false),
          Gap: ({ cursor }) =>
            Deferred.isDoneUnsafe(confirmation)
              ? skipped(cursor)
              : confirmed(cursor, true),
          Occurrence: (occurrence) =>
            Effect.gen(function* () {
              const body = yield* asSubscriber(
                subscription,
                subscription.feed.admit(input)
              ).pipe(
                Effect.andThen(Effect.map(encode(occurrence), JSON.stringify))
              );

              if (encoder.encode(body).length > maxBody) {
                yield* Effect.logWarning(
                  `Webhook delivery of ${occurrence.eventId} abandoned: its body is over 256 KiB`
                );

                return yield* skipped(occurrence.cursor);
              }

              if (yield* delivered(subscription, occurrence.eventId, body)) {
                return yield* moved(occurrence.cursor);
              }

              return yield* skipped(occurrence.cursor);
            }),
          Failed: () => Effect.void,
        });
    };

    const expired = ({ expiresAt }: Held): Effect.Effect<void> =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Effect.sleep(Duration.millis(Math.max(expiresAt - now, 0)))
      );

    const terminated = (subscription: Held, cause: Cause.Cause<unknown>) => {
      const refusal = refusalIn(cause);

      if (refusal === undefined) {
        return Cause.hasInterruptsOnly(cause) ? Effect.void : reported(cause);
      }

      return Effect.flatMap(randomToken, (token) =>
        post(
          subscription,
          `msg_terminated_${token}`,
          JSON.stringify({ type: "terminated", error: sentError(refusal) })
        ).pipe(
          Effect.retry({
            schedule: terminatedEnvelopeRetries,
            while: (failure) => !failure.final,
          }),
          Effect.ignore
        )
      );
    };

    const ended = (subscription: Held) =>
      Effect.sync(() => {
        if (holds(subscription)) {
          held.delete(subscription.id);
        }
      });

    const finished = (subscription: Held) =>
      Effect.suspend(() =>
        holds(subscription)
          ? Effect.andThen(ended(subscription), dropped(subscription.id))
          : Effect.void
      );

    const workerOf = (
      subscription: Held,
      input: Event.Any["input"]["Type"],
      cursor: string | null,
      confirmation: Deferred.Deferred<Confirmed, unknown>
    ) =>
      Effect.raceFirst(
        pushed(
          (from) =>
            Stream.unwrap(
              Effect.map(subscription.feed.stream(input), (read) => read(from))
            ),
          cursor,
          deliverTo(subscription, input, confirmation),
          {
            inOrder: true,
            resumesUnconfirmed: Deferred.isDoneUnsafe(confirmation),
          }
        ),
        expired(subscription)
      ).pipe(
        Effect.exit,
        Effect.tap(() => finished(subscription)),
        Effect.flatMap((exit) => {
          if (Deferred.isDoneUnsafe(confirmation)) {
            return Exit.isFailure(exit)
              ? terminated(subscription, exit.cause)
              : Effect.void;
          }

          return Exit.isFailure(exit)
            ? Deferred.failCause(confirmation, exit.cause)
            : Deferred.succeed(confirmation, { cursor, truncated: false });
        }),
        Effect.onInterrupt(() =>
          Effect.andThen(ended(subscription), Deferred.interrupt(confirmation))
        ),
        (worker) => asSubscriber(subscription, worker)
      );

    const remembered = ({ verifiedAs, expiresAt }: Held, now: number) =>
      Effect.sync(() => {
        for (const [each, expiry] of verified) {
          if (expiry <= now) {
            verified.delete(each);
          }
        }

        verified.set(
          verifiedAs,
          Math.max(expiresAt, verified.get(verifiedAs) ?? 0)
        );
      });

    const verify = (
      { verifiedAs, url, id, secret, feed }: Held,
      now: number
    ) => {
      if (
        (verified.get(verifiedAs) ?? 0) > now ||
        trusted(url, policy.allowedCallbacks)
      ) {
        return Effect.void;
      }

      return Effect.gen(function* () {
        const challenge = yield* randomToken;

        const echoed = yield* Effect.provideContext(
          challenged(
            {
              url,
              subscriptionId: id,
              webhookId: `msg_verification_${yield* randomToken}`,
              body: JSON.stringify({ type: "verification", challenge }),
              keys: [secret.key],
            },
            checkedHost(url, policy.dns)
          ),
          built
        ).pipe(
          Effect.mapError(({ category }) => failedCallback(feed, category))
        );

        if (echoed !== challenge) {
          return yield* failedCallback(feed, "challenge_failed");
        }
      });
    };

    const swapHeldWorker = (
      id: string,
      next: Held | undefined,
      worker: Effect.Effect<void, unknown, unknown>
    ) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const previous = yield* FiberMap.get(workers, id);

          if (next === undefined) {
            held.delete(id);
          } else {
            held.set(id, next);
          }

          yield* FiberMap.run(
            workers,
            id,
            Option.match(previous, {
              onNone: () => worker,
              onSome: (fiber) => Effect.andThen(Fiber.await(fiber), worker),
            })
          );
        })
      );

    const refreshed = (
      subscription: Held,
      granted: Granted,
      input: Event.Any["input"]["Type"],
      now: number
    ) =>
      Effect.gen(function* () {
        const { status, watermark } = subscription;

        const renewed: Held = {
          ...subscription,
          ...granted,
          ...(granted.secret.text === subscription.secret.text
            ? {}
            : {
                previous: {
                  key: subscription.secret.key,
                  until: now + Duration.toMillis(rotationGrace),
                },
              }),
          status: resumedWithFreshBudget(status),
        };

        const confirmation = yield* confirmedAt(watermark);

        yield* swapHeldWorker(
          renewed.id,
          renewed,
          workerOf(renewed, input, watermark, confirmation)
        );
        yield* remembered(renewed, now);
        yield* kept(renewed);

        return {
          id: renewed.id,
          refreshBefore: iso(renewed.expiresAt),
          cursor: watermark,
          truncated: false,
          deliveryStatus: status,
        };
      });

    const heldOf = (fields: Omit<Held, "verifiedAs" | "previous">): Held => ({
      ...fields,
      verifiedAs: `${fields.principal}\u0000${fields.url.href}`,
      previous: undefined,
    });

    const keptOf = ({ feed, keyed, input }: Subscribing) =>
      Effect.gen(function* () {
        const { schema } = keyed;

        if (storage === undefined || schema === undefined) {
          return { input: null, identity: null };
        }

        const identity = yield* Effect.service(feed.event.caller);

        return {
          input: yield* Effect.orDie(
            Schema.encodeUnknownEffect(Schema.toCodecJson(feed.event.input))(
              input
            )
          ),
          identity: yield* Effect.catch(
            Schema.encodeUnknownEffect(Schema.toCodecJson(schema))(identity),
            () => unencoded
          ),
        };
      });

    const restoredFrom = (
      store: Storage,
      feeds: readonly WebhookFeed[],
      keyed: Named,
      schema: Codec,
      id: string
    ) =>
      Effect.gen(function* () {
        const record = Option.getOrUndefined(yield* store.get(id));

        if (record === undefined) {
          return yield* dropped(id);
        }

        const feed = feeds.find(({ event }) => event.name === record.event);

        if (feed === undefined) {
          return;
        }

        const { expiresAt, url, secret } = record;

        if (expiresAt <= (yield* Clock.currentTimeMillis)) {
          return yield* dropped(id);
        }

        const input = yield* Schema.decodeEffect(
          Schema.toCodecJson(feed.event.input)
        )(record.input);

        const identity = yield* Schema.decodeEffect(Schema.toCodecJson(schema))(
          record.identity
        );

        const principal = keyed.principal(identity);

        const current = yield* idOf({
          feed,
          principal,
          input,
          delivery: { url },
        });

        if (current !== id) {
          yield* dropped(id);
        }

        if (held.has(current)) {
          return;
        }

        const subscription = heldOf({
          id: current,
          url,
          feed,
          principal,
          kept: { input: record.input, identity: record.identity },
          secret,
          context: Context.add(built, feed.event.caller, identity),
          expiresAt,
          status: record.status,
          watermark: record.watermark,
        });

        const confirmation = yield* confirmedAt(record.watermark);

        yield* swapHeldWorker(
          current,
          subscription,
          record.status.active
            ? workerOf(subscription, input, record.watermark, confirmation)
            : Effect.andThen(expired(subscription), finished(subscription))
        );

        if (current !== id) {
          yield* kept(subscription);
        }
      }).pipe(Effect.catchCause(reported));

    const serve = (feeds: readonly WebhookFeed[], keyed: Named) =>
      Effect.gen(function* () {
        const { schema } = keyed;

        const namesake = feeds.filter(
          ({ event }) =>
            served.has(event.name) && served.get(event.name)?.event !== event
        );

        if (namesake.length > 0) {
          return yield* Effect.die(
            new Error(
              `Webhook.layer serves ${named(namesake)} for two event types of that name (give each event type a name of its own, or each surface its own Webhook.layer)`
            )
          );
        }

        if (storage !== undefined && feeds.length > 0 && schema === undefined) {
          return yield* Effect.die(
            new Error(
              `Webhook.layer persists webhook subscriptions, but the authentication of ${named(feeds)} has no schema to keep a subscriber's identity by (give its Authentication.make a schema)`
            )
          );
        }

        const twice = feeds.filter(
          ({ event }) =>
            served.has(event.name) && served.get(event.name)?.schema !== schema
        );

        if (storage !== undefined && twice.length > 0) {
          return yield* Effect.die(
            new Error(
              `Webhook.layer persists webhook subscriptions, but ${named(twice)} is served by two authentications with different schemas (serve each event with one authentication, or give them one schema)`
            )
          );
        }

        for (const { event } of feeds) {
          served.set(event.name, { event, schema });
        }

        if (storage === undefined || schema === undefined) {
          return;
        }

        for (const id of storage.ids()) {
          yield* locked(id)(
            Effect.suspend(() =>
              held.has(id)
                ? Effect.void
                : restoredFrom(storage, feeds, keyed, schema, id)
            )
          );
        }
      });

    const terminatedOnRefusal = (id: string, cause: Cause.Cause<unknown>) =>
      Effect.gen(function* () {
        const existing = held.get(id);

        if (
          existing !== undefined &&
          refusalIn(cause) !== undefined &&
          (yield* Clock.currentTimeMillis) < existing.expiresAt
        ) {
          yield* swapHeldWorker(id, undefined, terminated(existing, cause));
          yield* dropped(id);
        }

        return yield* Effect.failCause(cause);
      });

    const subscribe = (
      subscribing: Subscribing
    ): Effect.Effect<Subscribed, unknown, unknown> =>
      Effect.gen(function* () {
        const {
          feed,
          principal,
          input,
          delivery: { url, secret },
          cursor,
          ttlMs,
        } = subscribing;

        const id = yield* idOf(subscribing);

        return yield* locked(id)(
          Effect.gen(function* () {
            yield* Effect.catchCause(feed.admit(input), (cause) =>
              terminatedOnRefusal(id, cause)
            );

            const now = yield* Clock.currentTimeMillis;

            const granted: Granted = {
              secret,
              context: Context.merge(
                built,
                snapshotOf(yield* Effect.context<unknown>())
              ),
              kept: yield* keptOf(subscribing),
              expiresAt: now + Duration.toMillis(grantOf(ttlMs, policy)),
            };

            const existing = held.get(id);

            if (existing !== undefined && now < existing.expiresAt) {
              return yield* refreshed(existing, granted, input, now);
            }

            const subscription = heldOf({
              ...granted,
              id,
              url,
              feed,
              principal,
              status: { active: true, lastDeliveryAt: null, lastError: null },
              watermark: cursor,
            });

            yield* verify(subscription, now);
            yield* remembered(subscription, now);

            const confirmation = yield* Deferred.make<Confirmed, unknown>();

            yield* swapHeldWorker(
              id,
              subscription,
              workerOf(subscription, input, cursor, confirmation)
            );

            const started = yield* Deferred.await(confirmation);

            yield* kept(subscription);

            return {
              id,
              refreshBefore: iso(subscription.expiresAt),
              cursor: started.cursor,
              truncated: started.truncated,
            };
          })
        );
      });

    const unsubscribe = (
      subscription: Subscription
    ): Effect.Effect<void, unknown, unknown> =>
      Effect.flatMap(idOf(subscription), (id) =>
        locked(id)(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;

            if (now < (held.get(id)?.expiresAt ?? 0)) {
              return yield* Effect.andThen(
                swapHeldWorker(id, undefined, Effect.void),
                dropped(id)
              );
            }

            if (storage?.ids().includes(id) === true) {
              return yield* dropped(id);
            }

            return yield* Event.SubscriptionError.of(
              subscription.feed.event.name,
              new Event.NotSubscribed()
            );
          })
        )
      );

    return { serve, subscribe, unsubscribe };
  });
