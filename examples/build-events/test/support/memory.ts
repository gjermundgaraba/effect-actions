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
