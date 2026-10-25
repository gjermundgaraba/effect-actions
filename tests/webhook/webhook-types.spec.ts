import { describe, expectTypeOf, it } from "@effect/vitest";
import type { Layer } from "effect";
import type { HttpClient } from "effect/http";
import type { Dns } from "effect/net";
import type { KeyValueStore } from "effect/persistence";
import * as Webhook from "../../src/webhook/Webhook.js";

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
