import { setImmediate as nextTurn } from "node:timers/promises";

import { afterAll, vi } from "@effect/vitest";
import { Effect, Layer, Option, Redacted, Schema, Stream } from "effect";
import type { Queue } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpServerRequest,
} from "effect/http";
import type { HttpRouter } from "effect/http";
import { Dns } from "effect/net";
import { KeyValueStore } from "effect/persistence";
import { TestClock } from "effect/testing";

import * as Authentication from "../../src/authentication/Authentication.js";
import * as Action from "../../src/contract/Action.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as Testing from "../../src/testing/Testing.js";
import * as Webhook from "../../src/webhook/Webhook.js";
import { actors, CurrentActor } from "./app/authorization.js";
import type { Actor as Identity } from "./app/authorization.js";

export const Changed = Event.make("user.changed", {
  description: "A user changed.",
  payload: { id: Schema.String, by: Schema.String },
  caller: CurrentActor,
});

const Actor = Schema.Struct({
  id: Schema.String,
  tenantId: Schema.String,
  permissions: Schema.Array(Schema.Literals(["users:read", "users:write"])),
});

export const Login = Authentication.make(
  "webhook-delivery.Login",
  CurrentActor,
  {
    principal: (actor) => actor.id,
    schema: Actor,
  }
);

export const Http = ActionHttp.make([Changed], { authentication: Login });

export interface Delivery {
  readonly id: string | null;
  readonly timestamp: string | null;
  readonly signature: string | null;
  readonly subscription: string | null;
  readonly redirect: Request["redirect"];
  readonly keepalive: boolean;
  readonly traceparent: string | null;
  readonly body: string;
}

const Body = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));

export const bodyOf = (delivery: Delivery) =>
  Schema.decodeSync(Body)(delivery.body);

export const secretOf = (seed: number) =>
  `whsec_${Buffer.from(Array.from({ length: 32 }, (_, index) => (seed + index) % 256)).toString("base64")}`;

/** Standard Webhooks' `v1,` signature of `id.timestamp.body` under `secret`, written apart. */
export const signatureOf = async (
  secret: string,
  id: string | null,
  timestamp: string | number | null,
  body: string
) => {
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(secret.slice("whsec_".length), "base64"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`)
  );

  return `v1,${Buffer.from(mac).toString("base64")}`;
};

export const signedBy = async (secret: string, delivery: Delivery) =>
  (delivery.signature ?? "")
    .split(" ")
    .includes(
      await signatureOf(secret, delivery.id, delivery.timestamp, delivery.body)
    );

type Answer = (body: Record<string, Schema.Json>) => Response;

export const acknowledging: Answer = ({ type, challenge }) =>
  type === "verification"
    ? Response.json({ challenge })
    : new Response(null, { status: 200 });

interface Change {
  readonly id: string;
  readonly by: string;
  readonly onlyTenant?: string | undefined;
}

/** How a world serves its event, beside `Webhook.layer`'s options. */
export interface WorldOptions extends Webhook.Options {
  readonly persist?: false | undefined;
  /** A log source fed from this queue, in place of the check source. */
  readonly emitted?: Queue.Queue<Change> | undefined;
  /** The store `persist` keeps subscriptions in, where they are kept. */
  readonly kept?: KeyValueStore.KeyValueStore | undefined;
  readonly over?: "HTTP" | "MCP" | "both" | undefined;
  /** What answers each POST to a callback, in place of the world's recording receiver. */
  readonly callbacks?:
    | Layer.Layer<never, never, HttpRouter.HttpRouter>
    | undefined;
  /** Whether the surfaces are given `Webhook.layer`; `true` by default. */
  readonly delivering?: boolean | undefined;
}

let inFlight = 0;

export const counting = <E, R>(
  client: Layer.Layer<HttpClient.HttpClient, E, R>
) =>
  Layer.effect(HttpClient.HttpClient)(
    Effect.map(
      HttpClient.HttpClient,
      HttpClient.transform((response) =>
        Effect.suspend(() => {
          inFlight += 1;

          return Effect.ensuring(
            response,
            Effect.sync(() => {
              inFlight -= 1;
            })
          );
        })
      )
    )
  ).pipe(Layer.provide(client));

export const makeWorld = ({
  emitted,
  kept,
  over = "HTTP",
  callbacks,
  delivering = true,
  ...options
}: WorldOptions = {}) => {
  const changes: Change[] = [];
  const received: Delivery[] = [];
  const revoked = new Set<string>();
  const requested: boolean[] = [];
  const known = new Map<string, Identity>(Object.entries(actors));

  const world = {
    changes,
    received,
    revoked,
    requested,
    known,
    checks: 0,
    failures: 0,
    authorizerDown: 0,
    answer: acknowledging,
  };

  const verify = (token: Redacted.Redacted) =>
    Effect.fromOption(
      Option.fromUndefinedOr(known.get(Redacted.value(token)))
    ).pipe(
      Effect.mapError(
        () => new Action.Unauthenticated({ message: "Unknown demo token." })
      )
    );

  const authorize = () =>
    Effect.gen(function* () {
      const inRequest = Option.isSome(
        yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest)
      );

      requested.push(inRequest);

      if (!inRequest && world.authorizerDown > 0) {
        world.authorizerDown -= 1;

        return yield* Effect.die(new Error("The policy store is down."));
      }

      const actor = yield* CurrentActor;

      if (revoked.has(actor.id) || !actor.permissions.includes("users:read")) {
        return yield* new Action.Forbidden({ message: "Revoked." });
      }
    });

  const changed =
    emitted === undefined
      ? Event.implement(
          Changed,
          {
            check: (_input, cursor) =>
              Effect.suspend(() => {
                world.checks += 1;

                if (world.failures > 0) {
                  world.failures -= 1;

                  return Effect.die(new Error("The source is down."));
                }

                return Effect.map(CurrentActor, (actor) => ({
                  cursor: String(changes.length),
                  events: changes
                    .slice(cursor === null ? changes.length : Number(cursor))
                    .flatMap((data) =>
                      data.onlyTenant === undefined ||
                      data.onlyTenant === actor.tenantId
                        ? [{ eventId: data.id, data }]
                        : []
                    ),
                }));
              }),
          },
          { authorize }
        )
      : Event.implement(
          Changed,
          {
            log: {
              emit: Stream.fromQueue(emitted).pipe(
                Stream.map((data) => ({ eventId: data.id, data }))
              ),
            },
          },
          { authorize }
        );

  const receiver = async (request: Request) => {
    const body = await request.text();

    received.push({
      id: request.headers.get("webhook-id"),
      timestamp: request.headers.get("webhook-timestamp"),
      signature: request.headers.get("webhook-signature"),
      subscription: request.headers.get("x-mcp-subscription-id"),
      redirect: request.redirect,
      keepalive: request.keepalive,
      traceparent: request.headers.get("traceparent"),
      body,
    });

    return world.answer(Schema.decodeSync(Body)(body));
  };

  const webhooks =
    kept === undefined
      ? Webhook.layer(options)
      : Webhook.layer({ ...options, persist: true }).pipe(
          Layer.provide(Layer.succeed(KeyValueStore.KeyValueStore, kept))
        );

  const overHttp = ActionHttp.layer(Http, changed);

  const overMcp = ActionMcp.layerHttp(changed, {
    name: "webhooks",
    version: "1.0.0",
    authentication: Login,
  });

  const surface = {
    HTTP: overHttp,
    MCP: overMcp,
    both: Layer.mergeAll(overHttp, overMcp),
  }[over];

  const authenticated = surface.pipe(
    Layer.provide(Authentication.layer(Login, verify))
  );

  const routes = (
    delivering ? authenticated.pipe(Layer.provide(webhooks)) : authenticated
  ).pipe(
    Layer.provide([
      Event.layerMemory,
      counting(
        callbacks === undefined
          ? Testing.layer(receiver)
          : Testing.layer(callbacks)
      ),
      Dns.layerStatic({
        hosts: {
          "hooks.example.com": ["93.184.216.34"],
          "hooks.example.com.evil.net": ["93.184.216.35"],
        },
      }),
      Layer.succeed(FetchHttpClient.RequestInit, { keepalive: true }),
    ])
  );

  return { world, server: Testing.layer(routes) };
};

export const sent = (token: string, route: string, body: Schema.Json) =>
  Effect.flatMap(HttpClient.HttpClient, (client) =>
    client.execute(
      HttpClientRequest.post(
        `http://localhost/api/events/user.changed/${route}`
      ).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.bodyJsonUnsafe(body)
      )
    )
  );

const Granted = Schema.Struct({
  id: Schema.String,
  refreshBefore: Schema.NullOr(Schema.String),
  cursor: Schema.NullOr(Schema.String),
  truncated: Schema.Boolean,
  deliveryStatus: Schema.optional(
    Schema.Struct({
      active: Schema.Boolean,
      lastDeliveryAt: Schema.NullOr(Schema.String),
      lastError: Schema.NullOr(Schema.String),
      failedSince: Schema.optional(Schema.String),
    })
  ),
});

export const url = "https://hooks.example.com/alice";

export const subscribed = (
  secret = secretOf(1),
  ttlMs?: number | null,
  {
    token = "alice",
    callback = url,
  }: { readonly token?: string; readonly callback?: string } = {}
) =>
  Effect.flatMap(
    sent(token, "subscribe", {
      input: {},
      delivery: { url: callback, secret },
      ...(ttlMs === undefined ? {} : { ttlMs }),
    }),
    (response) =>
      Effect.flatMap(response.json, Schema.decodeUnknownEffect(Granted))
  );

const counted = async <A>(work: Promise<A>): Promise<A> => {
  inFlight += 1;

  return await work.finally(() => {
    inFlight -= 1;
  });
};

const importKey = crypto.subtle.importKey.bind(crypto.subtle);

const sign = crypto.subtle.sign.bind(crypto.subtle);

const digest = crypto.subtle.digest.bind(crypto.subtle);

const spies = [
  vi
    .spyOn(crypto.subtle, "importKey")
    .mockImplementation(async (...args) => await counted(importKey(...args))),
  vi
    .spyOn(crypto.subtle, "sign")
    .mockImplementation(async (...args) => await counted(sign(...args))),
  vi
    .spyOn(crypto.subtle, "digest")
    .mockImplementation(async (...args) => await counted(digest(...args))),
];

afterAll(() => {
  for (const spy of spies) {
    spy.mockRestore();
  }
});

const turn = Effect.promise(async () => {
  await nextTurn();
});

const quietTurns = 3;

const maxTurns = 10_000;

/**
 * Waits, in real time, until `done` holds once no signing or in-process POST has been in flight
 * for three scheduler turns, dying with `done` named where it never does within 10,000 turns:
 * the test clock cannot see that work, and moved during it would let an attempt's 5-second
 * timeout or a retry's wait elapse in time the work never took.
 */
export const settled = (
  done: () => boolean = () => true
): Effect.Effect<void> => {
  const waited = (quiet: number, turns: number): Effect.Effect<void> => {
    if (quiet >= quietTurns && done()) {
      return Effect.void;
    }

    return turns === maxTurns
      ? Effect.die(new Error(`Never settled with ${String(done)}`))
      : Effect.flatMap(turn, () =>
          waited(inFlight === 0 ? quiet + 1 : 0, turns + 1)
        );
  };

  return waited(0, 0);
};

/**
 * Steps the clock a second at a time, each step once `settled`, until `done`, dying with `done`
 * named where it does not within `seconds`, by default 3 hours.
 */
export const until = (
  done: () => boolean,
  seconds = 3 * 60 * 60
): Effect.Effect<void> =>
  Effect.flatMap(settled(), () => {
    if (done()) {
      return Effect.void;
    }

    return seconds <= 0
      ? Effect.die(
          new Error(`Never held with the clock moved on: ${String(done)}`)
        )
      : Effect.andThen(TestClock.adjust("1 second"), until(done, seconds - 1));
  });

/** Lets `seconds` pass, a second at a time, each step once `settled`, and settles once more. */
export const passed = (seconds = 60): Effect.Effect<void> =>
  seconds <= 0
    ? settled()
    : Effect.flatMap(settled(), () =>
        Effect.andThen(TestClock.adjust("1 second"), passed(seconds - 1))
      );

export const events = (received: readonly Delivery[]) =>
  received.flatMap((delivery) => {
    const body = bodyOf(delivery);

    return body["type"] === undefined ? [body] : [];
  });
