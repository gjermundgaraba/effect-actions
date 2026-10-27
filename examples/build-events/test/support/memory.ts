import { setImmediate } from "node:timers/promises";

import * as Event from "@gjermundgaraba/effect-actions/Event";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Effect, Layer } from "effect";
import type { HttpClient } from "effect/http";
import { Dns } from "effect/net";
import { KeyValueStore } from "effect/persistence";

import { BuildStore } from "../../src/builds/store.js";
import { Approvers } from "../../src/deploys/approvers.js";

const unreached = async () => new Response(null, { status: 503 });

// What the routes need, in memory: the stores, the events announced, and for webhook delivery a client, a resolver
// and a store for the subscriptions. `subscribers` answers each POST in place of a member's server, and
// hooks.example.com resolves to a public address: delivery refuses a private or loopback one.
export const inMemory = <R = never>(
  subscribers: Layer.Layer<HttpClient.HttpClient, never, R> = Testing.layer(
    unreached
  )
) =>
  Layer.mergeAll(
    BuildStore.layerMemory,
    Approvers.layerMemory,
    Event.layerMemory,
    subscribers,
    Dns.layerStatic({ hosts: { "hooks.example.com": ["93.184.216.34"] } }),
    KeyValueStore.layerMemory
  );

// Waits for `done` while requests in memory resolve: a subscription made through them runs on
// promises the test clock does not drive.
export const settled = <E, R>(done: Effect.Effect<boolean, E, R>) =>
  Effect.repeat(
    Effect.andThen(
      Effect.promise(async () => {
        await setImmediate();
      }),
      done
    ),
    { until: (finished) => finished, times: 200 }
  );
