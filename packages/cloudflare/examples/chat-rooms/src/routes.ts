import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { env } from "cloudflare:workers";
import { Layer } from "effect";
import { RpcServer } from "effect/rpc";

import { LobbyHttp, RoomHttp } from "./Api.js";
import { messageEvents } from "./chat/events.js";
import { messages } from "./chat/handlers.js";
import { Login } from "./identity/Identity.js";
import { authenticate } from "./identity/verifier.js";
import { LobbyCalls } from "./lobby/Calls.js";
import { previewEvents } from "./lobby/events.js";
import { calls as lobbyHandlers, lobby } from "./lobby/handlers.js";
import {
  LobbyRpc,
  protocolVersion,
  RoomRpc,
  unsupportedProtocol,
} from "./Rpc.js";

const room = [messages, messageEvents];

const byRoom = (input: { readonly room: string }) => input.room;

export const rooms = ActionDurableObject.placed(RoomHttp, {
  readMessages: byRoom,
  postMessage: byRoom,
  deleteMessage: byRoom,
  "message.posted": byRoom,
});

const pageSocket = ActionDurableObject.layerWebSocket({
  path: "/rpc",
  protocol: { version: protocolVersion, code: unsupportedProtocol },
});

export const roomRoutes = Layer.mergeAll(
  ActionRpc.layer(RoomRpc, room).pipe(Layer.provide(pageSocket)),
  ActionHttp.layer(RoomHttp, room)
).pipe(Layer.provide(authenticate));

export const lobbyRoutes = ActionRpc.layer(LobbyRpc, [previewEvents]).pipe(
  Layer.provide(pageSocket)
);

export const lobbyCalls = RpcServer.layer(LobbyCalls).pipe(
  Layer.provide(lobbyHandlers)
);

const inRooms = ActionDurableObject.reaching(rooms, () => env.CHAT_ROOM);

export const workerRoutes = Layer.mergeAll(
  ActionHttp.layer(LobbyHttp, lobby),
  ActionHttp.layer(RoomHttp, inRooms),
  ActionMcp.layerHttp([lobby, ...inRooms], {
    name: "chat-rooms",
    version: "1.0.0",
    authentication: Login,
    requestScoped: true,
  })
).pipe(Layer.provide(authenticate));
