import { describe, expectTypeOf, it } from "@effect/vitest";
import { Effect, type Layer, type Stream } from "effect";
import type { HttpClient } from "effect/http";
import type { Dns } from "effect/net";
import type { KeyValueStore } from "effect/persistence";
import type * as Event from "../../src/contract/Event.js";
import type { Receiving } from "../../src/contract/receiving.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as Webhook from "../../src/webhook/Webhook.js";
import { Login, Watched } from "../support/event-types.js";

describe("Webhook.layer", () => {
  it("needs a KeyValueStore with persist, and none without", () => {
    expectTypeOf<Layer.Services<typeof plain>>().toEqualTypeOf<HttpClient.HttpClient | Dns.Dns>();
    expectTypeOf<Layer.Services<typeof persisted>>().toEqualTypeOf<
      HttpClient.HttpClient | Dns.Dns | KeyValueStore.KeyValueStore
    >();
  });

  it("needs no Dns with resolveCallbacks false", () => {
    expectTypeOf<Layer.Services<typeof trusting>>().toEqualTypeOf<HttpClient.HttpClient>();
    expectTypeOf<Layer.Services<typeof trustingPersisted>>().toEqualTypeOf<
      HttpClient.HttpClient | KeyValueStore.KeyValueStore
    >();
  });
});

const plain = Webhook.layer();

const persisted = Webhook.layer({ persist: true });

const trusting = Webhook.layer({ resolveCallbacks: false });

const trustingPersisted = Webhook.layer({ persist: true, resolveCallbacks: false });

const delivery = Webhook.delivery({ baseUrl: "https://notifier.example.com" });

declare const either: "poll" | Event.WebhookDelivery;

export const watchOverHttp = Effect.gen(function* () {
  const http = yield* ActionHttp.client(ActionHttp.make([Watched], { authentication: Login }));

  const delivered = http.watch(Watched, { id: "a" }, { mode: delivery });
  const chosen = http.watch(Watched, { id: "a" }, { mode: either });
  const polled = http.watch(Watched, { id: "a" }, { mode: "poll" });

  expectTypeOf<Stream.Services<typeof delivered>>().toEqualTypeOf<Receiving>();
  expectTypeOf<Stream.Services<typeof chosen>>().toEqualTypeOf<Receiving>();
  expectTypeOf<Stream.Services<typeof polled>>().toBeNever();
});

export const watchOverMcp = Effect.gen(function* () {
  const mcp = yield* ActionMcp.client([Watched], { authentication: Login });

  const delivered = mcp.watch(Watched, { id: "a" }, { mode: delivery });
  const chosen = mcp.watch(Watched, { id: "a" }, { mode: either });
  const streamed = mcp.watch(Watched, { id: "a" });

  expectTypeOf<Stream.Services<typeof delivered>>().toEqualTypeOf<Receiving>();
  expectTypeOf<Stream.Services<typeof chosen>>().toEqualTypeOf<Receiving>();
  expectTypeOf<Stream.Services<typeof streamed>>().toBeNever();
});
