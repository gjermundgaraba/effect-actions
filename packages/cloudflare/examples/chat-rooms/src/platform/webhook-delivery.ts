import * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";
import * as Webhook from "@gjermundgaraba/effect-actions/Webhook";
import { Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { KeyValueStore } from "effect/persistence";

export const layerRoomWebhooks = Webhook.layer({
  persist: true,
  resolveCallbacks: false,
}).pipe(
  Layer.provide(ActionEntity.layerClock),
  Layer.provide(KeyValueStore.layerSql({ table: "webhook_subscriptions" })),
  Layer.provide(FetchHttpClient.layer)
);
