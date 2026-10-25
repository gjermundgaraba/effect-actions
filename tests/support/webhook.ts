import { Effect, Layer, Option, type Queue, Redacted, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpServerRequest } from "effect/http";
import { Dns } from "effect/net";
import { KeyValueStore } from "effect/persistence";
import { TestClock } from "effect/testing";
import * as Action from "../../src/contract/Action.js";
import * as Authentication from "../../src/authentication/Authentication.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as Testing from "../../src/testing/Testing.js";
import * as Webhook from "../../src/webhook/Webhook.js";
import { type Actor as Identity, actors, CurrentActor } from "./app/authorization.js";

const Changed = Event.make("user.changed", {
  description: "A user changed.",
  payload: { id: Schema.String, by: Schema.String },
  caller: CurrentActor,
});

const Actor = Schema.Struct({
  id: Schema.String,
  tenantId: Schema.String,
  permissions: Schema.Array(Schema.Literals(["users:read", "users:write"])),
});

const Login = Authentication.make("webhook-delivery.Login", CurrentActor, {
  principal: (actor) => actor.id,
  schema: Actor,
});

const Http = ActionHttp.make([Changed], { authentication: Login });

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

export const bodyOf = (delivery: Delivery) => Schema.decodeUnknownSync(Body)(delivery.body);

export const secretOf = (seed: number) =>
  `whsec_${Buffer.from(Array.from({ length: 32 }, (_, index) => (seed + index) % 256)).toString("base64")}`;

export const signedBy = async (secret: string, delivery: Delivery) => {
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(secret.slice("whsec_".length), "base64"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const expected = Buffer.from(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${delivery.id}.${delivery.timestamp}.${delivery.body}`),
    ),
  ).toString("base64");

  return (delivery.signature ?? "").split(" ").includes(`v1,${expected}`);
};

type Answer = (body: Record<string, Schema.Json>) => Response;

export const acknowledging: Answer = ({ type, challenge }) =>
  type === "verification" ? Response.json({ challenge }) : new Response(null, { status: 200 });

interface Change {
  readonly id: string;
  readonly by: string;
  readonly onlyTenant?: string | undefined;
}

export const makeWorld = (
  options: Webhook.Options & { readonly persist?: false | undefined } = {},
  emitted?: Queue.Queue<Change>,
  kept?: KeyValueStore.KeyValueStore,
  over: "HTTP" | "MCP" | "both" = "HTTP",
) => {
  const changes: Array<Change> = [];
  const received: Array<Delivery> = [];
  const revoked = new Set<string>();
  const requested: Array<boolean> = [];
  const known = new Map<string, Identity>(Object.entries(actors));

  const world = {
    changes,
    received,
    revoked,
    requested,
    known,
    failures: 0,
    authorizerDown: 0,
    answer: acknowledging,
    answered: 0,
  };

  const verify = (token: Redacted.Redacted<string>) =>
    Effect.fromOption(Option.fromUndefinedOr(known.get(Redacted.value(token)))).pipe(
      Effect.mapError(() => new Action.Unauthenticated({ message: "Unknown demo token." })),
    );

  const authorize = () =>
    Effect.gen(function* () {
      const inRequest = Option.isSome(
        yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest),
      );

      requested.push(inRequest);

      if (!inRequest && world.authorizerDown > 0) {
        world.authorizerDown -= 1;

        return yield* Effect.die(new Error("The policy store is down."));
      }

      const actor = yield* CurrentActor;

      if (revoked.has(actor.id) || !actor.permissions.includes("users:read"))
        return yield* new Action.Forbidden({ message: "Revoked." });
    });

  const changed =
    emitted === undefined
      ? Event.implement(
          Changed,
          {
            check: (_input, cursor) =>
              world.failures > 0
                ? Effect.suspend(() => {
                    world.failures -= 1;

                    return Effect.die(new Error("The source is down."));
                  })
                : Effect.map(CurrentActor, (actor) => ({
                    cursor: String(changes.length),
                    events: changes
                      .slice(cursor === null ? changes.length : Number(cursor))
                      .filter(
                        ({ onlyTenant }) =>
                          onlyTenant === undefined || onlyTenant === actor.tenantId,
                      )
                      .map((data) => ({ eventId: data.id, data })),
                  })),
          },
          { authorize },
        )
      : Event.implement(
          Changed,
          {
            log: {
              emit: Stream.fromQueue(emitted).pipe(
                Stream.map((data) => ({ eventId: data.id, data })),
              ),
            },
          },
          { authorize },
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

    return world.answer(Schema.decodeUnknownSync(Body)(body));
  };

  const webhooks =
    kept === undefined
      ? Webhook.layer(options)
      : Webhook.layer({ ...options, persist: true }).pipe(
          Layer.provide(Layer.succeed(KeyValueStore.KeyValueStore, kept)),
        );

  const overHttp = ActionHttp.layer(Http, changed);

  const overMcp = ActionMcp.layerHttp(changed, {
    name: "webhooks",
    version: "1.0.0",
    authentication: Login,
  });

  const surface = { HTTP: overHttp, MCP: overMcp, both: Layer.mergeAll(overHttp, overMcp) }[over];

  const routes = surface.pipe(
    Layer.provide(Authentication.layer(Login, verify)),
    Layer.provide(webhooks),
    Layer.provide([
      Event.layerMemory,
      Layer.effect(HttpClient.HttpClient)(
        Effect.map(
          HttpClient.HttpClient,
          HttpClient.transform((response) =>
            Effect.ensuring(
              response,
              Effect.sync(() => {
                world.answered += 1;
              }),
            ),
          ),
        ),
      ).pipe(Layer.provide(Testing.layer(receiver))),
      Dns.layerStatic({
        hosts: {
          "hooks.example.com": ["93.184.216.34"],
          "hooks.example.com.evil.net": ["93.184.216.35"],
        },
      }),
      Layer.succeed(FetchHttpClient.RequestInit, { keepalive: true }),
    ]),
  );

  return { world, server: Testing.layer(routes) };
};

export const sent = (token: string, route: string, body: Schema.Json) =>
  Effect.flatMap(HttpClient.HttpClient, (client) =>
    client.execute(
      HttpClientRequest.post(`http://localhost/api/events/user.changed/${route}`).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
    ),
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
    }),
  ),
});

export const url = "https://hooks.example.com/alice";

export const subscribed = (
  secret = secretOf(1),
  ttlMs?: number | null,
  { token = "alice", callback = url }: { readonly token?: string; readonly callback?: string } = {},
) =>
  Effect.flatMap(
    sent(token, "subscribe", {
      input: {},
      delivery: { url: callback, secret },
      ...(ttlMs === undefined ? {} : { ttlMs }),
    }),
    (response) => Effect.flatMap(response.json, Schema.decodeUnknownEffect(Granted)),
  );

export const turn = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

export const until = (done: () => boolean) =>
  Effect.repeat(Effect.andThen(TestClock.adjust("1 second"), turn), { until: done, times: 60 });

export const events = (received: ReadonlyArray<Delivery>) =>
  received.map(bodyOf).filter(({ type }) => type === undefined);
