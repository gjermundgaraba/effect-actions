import * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import * as Stored from "@gjermundgaraba/effect-actions/Stored";
import * as Webhook from "@gjermundgaraba/effect-actions/Webhook";
import { Effect, Layer, Schema } from "effect";
import { Entity } from "effect/cluster";

import { RoomHttp } from "./Api.js";
import { DemoRoomName } from "./chat/Chat.js";
import { messageEvents } from "./chat/events.js";
import { messages } from "./chat/handlers.js";
import { Room as CurrentRoom } from "./chat/room.js";
import { Room } from "./entities.js";
import { Login } from "./identity/Identity.js";
import { authenticate } from "./identity/verifier.js";
import { layerObjectSql } from "./platform/object-sql.js";
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

const roomServices = Layer.merge(Stored.layerEvents, roomWebhooks).pipe(
  Layer.provideMerge(Layer.mergeAll(layerSqlMessages, roomOfAddress)),
  Layer.provideMerge(layerObjectSql)
);

export const entities = ActionEntity.layer(Room, [messages, messageEvents], {
  services: roomServices,
}).pipe(Layer.provide(authenticate));

const inRooms = ActionEntity.reaching(Room);

export const workerRoutes = Layer.mergeAll(
  ActionHttp.layer(RoomHttp, inRooms),
  ActionMcp.layerHttp(inRooms, {
    name: "chat-rooms",
    version: "1.0.0",
    authentication: Login,
    requestScoped: true,
  })
).pipe(Layer.provide(authenticate));
