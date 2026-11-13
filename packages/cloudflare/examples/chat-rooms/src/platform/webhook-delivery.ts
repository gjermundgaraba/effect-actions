import { Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { KeyValueStore } from "effect/persistence";

export const layerWebhookDelivery = Layer.mergeAll(
  KeyValueStore.layerSql({ table: "webhook_subscriptions" }),
  FetchHttpClient.layer
);
