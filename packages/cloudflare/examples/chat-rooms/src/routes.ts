import * as ActionCluster from "@gjermundgaraba/effect-actions-cloudflare/ActionCluster";
import * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import * as Webhook from "@gjermundgaraba/effect-actions/Webhook";
import { Effect, Layer, Schema } from "effect";
import { Entity } from "effect/cluster";

import { RoomHttp } from "./Api.js";
import { DemoRoomName, MessagePosted, Messages } from "./chat/Chat.js";
import { messageEvents } from "./chat/events.js";
import { messages } from "./chat/handlers.js";
import { Room as CurrentRoom } from "./chat/room.js";
import { Room } from "./entities.js";
import { Login } from "./identity/Identity.js";
import { authenticate } from "./identity/verifier.js";
import { layerSqlMessages } from "./platform/sql-messages.js";
import { layerWebhookDelivery } from "./platform/webhook-delivery.js";

const roomOfAddress = Layer.effect(CurrentRoom)(
  Effect.flatMap(Entity.CurrentAddress, ({ entityId }) =>
    Effect.orDie(Schema.decodeUnknownEffect(DemoRoomName)(entityId))
  )
);

const roomWebhooks = Webhook.layer({
  persist: true,
  resolveCallbacks: false,
}).pipe(Layer.provide(layerWebhookDelivery));

const roomServices = roomWebhooks.pipe(
  Layer.provideMerge(Layer.mergeAll(layerSqlMessages, roomOfAddress)),
  Layer.provideMerge(ActionCluster.layerObject)
);

export const rooms = ActionEntity.layer(Room, [messages, messageEvents], {
  services: roomServices,
}).pipe(Layer.provide(authenticate));

const inRooms = ActionEntity.reaching(Room);

export const workerRoutes = ActionHttp.layer(RoomHttp, inRooms).pipe(
  Layer.provide(authenticate)
);

export const agents = ActionMcp.layerHttp(inRooms, {
  actions: [...Messages, MessagePosted],
  name: "chat-rooms",
  version: "1.0.0",
  authentication: Login,
}).pipe(Layer.provide(authenticate));
