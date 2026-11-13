import * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import * as Stored from "@gjermundgaraba/effect-actions/Stored";
import { Effect, Layer, Schema } from "effect";
import { Entity } from "effect/cluster";
import { KeyValueStore } from "effect/persistence";

import { LobbyHttp, RoomHttp } from "./Api.js";
import { DemoRoomName } from "./chat/Chat.js";
import { messageEvents } from "./chat/events.js";
import { messages, roomTells } from "./chat/handlers.js";
import { Room as CurrentRoom } from "./chat/room.js";
import { Lobby, Room } from "./entities.js";
import { Login } from "./identity/Identity.js";
import { authenticate } from "./identity/verifier.js";
import { previewEvents } from "./lobby/events.js";
import { lobby, roomChanges } from "./lobby/handlers.js";
import {
  layerLobbyClient,
  layerRoomMailbox,
} from "./platform/cluster-clients.js";
import { layerObjectSql } from "./platform/object-sql.js";
import { layerSqlMessages } from "./platform/sql-messages.js";
import { layerSqlPreviews } from "./platform/sql-previews.js";
import { layerRoomWebhooks } from "./platform/webhook-delivery.js";

const roomOfAddress = Layer.effect(CurrentRoom)(
  Effect.flatMap(Entity.CurrentAddress, ({ entityId }) =>
    Effect.orDie(Schema.decodeUnknownEffect(DemoRoomName)(entityId))
  )
);

const roomServices = Layer.mergeAll(
  Stored.layerEvents,
  Stored.layerIdempotency.pipe(Layer.provide(KeyValueStore.layerSql())),
  layerRoomWebhooks
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerSqlMessages,
      roomOfAddress,
      layerRoomMailbox,
      layerLobbyClient
    )
  ),
  Layer.provideMerge(layerObjectSql)
);

const lobbyServices = Layer.mergeAll(Stored.layerEvents, layerSqlPreviews).pipe(
  Layer.provideMerge(layerObjectSql)
);

export const entities = Layer.mergeAll(
  ActionEntity.layer(Room, [messages, messageEvents], {
    services: roomServices,
    rpcs: roomTells,
    concurrency: 1,
  }).pipe(Layer.provide(authenticate)),
  ActionEntity.layer(Lobby, [lobby, previewEvents], {
    services: lobbyServices,
    rpcs: roomChanges,
  })
);

const inRooms = ActionEntity.reaching(Room);

const inLobby = ActionEntity.reaching(Lobby);

export const workerRoutes = Layer.mergeAll(
  ActionHttp.layer(RoomHttp, inRooms),
  ActionHttp.layer(LobbyHttp, inLobby),
  ActionMcp.layerHttp([...inRooms, ...inLobby], {
    name: "chat-rooms",
    version: "1.0.0",
    authentication: Login,
    requestScoped: true,
  })
).pipe(Layer.provide(authenticate));
