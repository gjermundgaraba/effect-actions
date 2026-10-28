# Webhook

`Webhook.layer` adds webhook delivery to the MCP endpoints and HTTP routes that serve [events](Event.md): a subscriber names a callback URL and a secret, the server checks that the callback asked for them, and POSTs each occurrence the subscriber may see there, signed, until the subscription lapses, is unsubscribed or is refused. A subscriber keeps it by subscribing again before the time each answer gives. It follows SEP-3415's webhook delivery, so it is experimental, as [events](Event.md) are.

A message the library throws says its fix; for a compiler diagnostic or Effect's own error, search [Webhook-failures.md](Webhook-failures.md). For one symbol, `grep -rn <symbol> node_modules/@gjermundgaraba/effect-actions/dist/`: each declaration's JSDoc carries its rules and gotchas, and this page only what an example cannot show.

## Deliver events by webhook

Provide `Webhook.layer()` to the routes. One layer holds the subscriptions of every surface it is provided to, so a subscription made over MCP is the one HTTP refreshes. Which events it offers is its first gotcha.

```ts example=build-events/src/routes.ts
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as Webhook from "@gjermundgaraba/effect-actions/Webhook";
import { Layer } from "effect";
import { RpcSerialization, RpcServer } from "effect/rpc";

import { Http } from "./Api.js";
import { buildEvents } from "./builds/events.js";
import { builds } from "./builds/handlers.js";
import { logs } from "./builds/log.js";
import { statusEvents } from "./builds/status.js";
import { deployEvents } from "./deploys/events.js";
import { deploys } from "./deploys/handlers.js";
import { Login } from "./identity/Identity.js";
import { authenticate } from "./identity/verifier.js";
import { Rpc } from "./Rpc.js";

const implementations = [
  builds,
  logs,
  buildEvents,
  statusEvents,
  deploys,
  deployEvents,
];

const mcp = ActionMcp.layerHttp(
  [builds, buildEvents, statusEvents, deploys, deployEvents],
  {
    name: "build-events",
    version: "1.0.0",
    authentication: Login,
  }
);

const api = ActionHttp.layer(Http, implementations);

const rpc = ActionRpc.layer(Rpc, implementations).pipe(
  Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerNdjson)
);

export const routes = Layer.mergeAll(mcp, api, rpc).pipe(
  Layer.provide(authenticate),
  Layer.provide(Webhook.layer({ persist: true }))
);
```

The layer needs an `HttpClient` to POST, `Dns` to check where each callback resolves, unless `resolveCallbacks` is `false`, and, with `persist`, a `KeyValueStore`: the entrypoint, [build-events/src/server.ts](../examples/build-events/src/server.ts), provides all three.

Its options, how long a subscription is granted, which callbacks skip the handshake and the address check, and how long a failing delivery is retried, are `Webhook.Options`; what each POST holds is on `layer`.

- **Which deployment.** Subscriptions are delivered from the server's memory, so a long-lived process serves them and a serverless host cannot; a Cloudflare Durable Object can, with `@gjermundgaraba/effect-actions-cloudflare`'s `ActionDurableObject.layerWebhooks`. A restart drops them until each subscriber's next refresh, unless the layer keeps them: `Webhook.layer({ persist: true })` writes each to the application's `KeyValueStore`, and each surface restores its own as it builds, the subscriber's identity kept by its authentication's `schema`, as `server.ts` and [build-events/src/identity/Identity.ts](../examples/build-events/src/identity/Identity.ts) show. What a restored delivery lacks is on `Webhook.Options.persist`. The layer is its store's one writer: give each process a store of its own, since replicas sharing one would each deliver every subscription and lose each other's writes.

## Subscribe a callback

Over MCP a subscriber sends SEP-3415's `events/subscribe` and `events/unsubscribe`; over HTTP it POSTs to the binding's `<prefix>/events/<name>/subscribe` and `/unsubscribe`, as below, whose OpenAPI document describes each field. A subscription is one per subscriber, event, input and URL: subscribing again refreshes it, and a new secret replaces the old one, as `Webhook.layer` says.

```ts example=build-events/test/webhooks.test.ts
import { describe, expect, it } from "@effect/vitest";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Effect, Layer, Queue, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { Http } from "../src/Api.js";
import { routes } from "../src/routes.js";
import { inMemory } from "./support/memory.js";

const secret = `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")}`;

const signed = async (request: Request, body: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(secret.slice("whsec_".length), "base64"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signedContent = [
    request.headers.get("webhook-id"),
    request.headers.get("webhook-timestamp"),
    body,
  ].join(".");

  const expected = Buffer.from(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(signedContent)
    )
  ).toString("base64");

  return (request.headers.get("webhook-signature") ?? "")
    .split(" ")
    .includes(`v1,${expected}`);
};

const Delivered = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Json)
);

interface Received {
  readonly body: typeof Delivered.Type;
  readonly signed: boolean;
}

const subscriber =
  (received: Queue.Enqueue<Received>) => async (request: Request) => {
    const text = await request.text();
    const body = Schema.decodeSync(Delivered)(text);

    Queue.offerUnsafe(received, { body, signed: await signed(request, text) });

    return body["type"] === "verification"
      ? Response.json({ challenge: body["challenge"] })
      : new Response(null);
  };

const served = (received: Queue.Enqueue<Received>) =>
  Testing.layer(routes).pipe(
    Layer.provide(inMemory(Testing.layer(subscriber(received))))
  );

const Subscribed = Schema.Struct({
  id: Schema.String,
  refreshBefore: Schema.NullOr(Schema.String),
  deliveryStatus: Schema.optional(
    Schema.Struct({
      active: Schema.Boolean,
      lastError: Schema.NullOr(Schema.String),
    })
  ),
});

const subscribe = Effect.flatMap(HttpClient.HttpClient, (client) =>
  client.execute(
    HttpClientRequest.post("/api/events/build.finished/subscribe").pipe(
      HttpClientRequest.bearerToken("grace"),
      HttpClientRequest.bodyJsonUnsafe({
        input: { status: "passed" },
        delivery: { url: "https://hooks.example.com/grace", secret },
      })
    )
  )
).pipe(
  Effect.flatMap((response) => response.json),
  Effect.flatMap(Schema.decodeUnknownEffect(Subscribed))
);

describe("the service, by webhook", () => {
  it.effect("POSTs each build a member may see to its callback, signed", () =>
    Effect.flatMap(Queue.unbounded<Received>(), (received) =>
      Effect.gen(function* () {
        const ada = yield* ActionHttp.client(Http, {
          transformClient: HttpClient.mapRequest(
            HttpClientRequest.bearerToken("ada")
          ),
        });

        const subscription = yield* subscribe;
        const verification = yield* Queue.take(received);

        yield* ada.finishBuild({ pipeline: "api", status: "passed" });
        yield* ada.finishBuild({ pipeline: "web", status: "passed" });

        const delivery = yield* Queue.take(received);

        const refreshed = yield* subscribe;

        expect(verification).toMatchObject({
          body: { type: "verification" },
          signed: true,
        });
        expect(delivery).toMatchObject({
          body: {
            name: "build.finished",
            data: { id: "build-2", pipeline: "web" },
          },
          signed: true,
        });
        expect(refreshed).toMatchObject({
          id: subscription.id,
          deliveryStatus: { active: true, lastError: null },
        });
      }).pipe(Effect.provide(served(received)))
    )
  );
});
```

## Watch by webhook

A client of an MCP endpoint or of HTTP routes watches by webhook with `mode: Webhook.delivery({ baseUrl })`: the watch keeps a place at `Webhook.layerReceiver`, a route this process serves, subscribes that route's path under `baseUrl` with the place's id and secret, reads what the server POSTs there, refreshes the subscription while it is read, and unsubscribes when it ends. Such a watch requires the receiver in its type; it is built once, the watch given it beside the routes (`Layer.provideMerge`). It is served by the process that watches: behind an edge, route its path there, and where nothing can reach the process, watch by stream or poll instead.

```ts example=build-events/src/notifier/routes.ts
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Webhook from "@gjermundgaraba/effect-actions/Webhook";
import { Effect, Layer, Predicate, Stream } from "effect";
import type { Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { KeyValueStore } from "effect/persistence";

import { Http } from "../Api.js";
import { BuildFinished } from "../builds/Builds.js";
import { Notices } from "./Notices.js";

/** Where build-events is, who the notifier signs in as there, and where it is reached itself. */
export interface NotifierOptions {
  readonly buildEvents: string;
  readonly token: string | Redacted.Redacted;
  /** This process's public https origin, which build-events POSTs to. */
  readonly publicUrl: string;
}

const receiver = Webhook.layerReceiver({ path: "/hooks/builds" });

const watcher = ({ buildEvents, token, publicUrl }: NotifierOptions) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const notices = yield* Notices;

      const builds = yield* ActionHttp.client(Http, {
        baseUrl: buildEvents,
        transformClient: HttpClient.mapRequest(
          HttpClientRequest.bearerToken(token)
        ),
      });

      yield* Effect.forkScoped(
        builds
          .watch(
            BuildFinished,
            { status: "failed" },
            {
              mode: Webhook.delivery({ baseUrl: publicUrl }),
              resume: {
                store: yield* KeyValueStore.KeyValueStore,
                key: "failed-builds",
              },
            }
          )
          .pipe(
            Stream.runForEach((received) =>
              Predicate.isTagged(received, "Occurrence")
                ? notices.add(received.data)
                : Effect.logWarning("Failed builds were missed", received)
            ),
            Effect.tapCause(Effect.logError)
          )
      );
    })
  );

/** The notifier's routes: the receiver, and the watch reading from that same receiver. */
export const notifier = (options: NotifierOptions) =>
  watcher(options).pipe(Layer.provideMerge(receiver));
```

[build-events/test/notifier.test.ts](../examples/build-events/test/notifier.test.ts) runs both services in memory. What the receiver accepts is on `layerReceiver`, and what a watch needs on `delivery`.
