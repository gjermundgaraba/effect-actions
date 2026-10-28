import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";

import { Activity } from "./chat/activity.js";
import { DemoRoomName } from "./chat/Chat.js";
import { Room } from "./chat/room.js";
import { MessageStore } from "./chat/store.js";
import { layerKvPreviews } from "./platform/kv-previews.js";
import {
  layerActivity,
  layerLobbyHost,
  tellLobby,
} from "./platform/lobby-stubs.js";
import { layerSql } from "./platform/sql-store.js";
import {
  lobbyCalls,
  lobbyRoutes,
  roomRoutes,
  rooms,
  workerRoutes,
} from "./routes.js";

export { RoomsEntrypoint } from "./rooms-entrypoint.js";

const decodeRoom = Schema.decodeUnknownEffect(DemoRoomName);

export class ChatRoom extends ActionDurableObject.make({
  placed: rooms,
  services: () =>
    Layer.mergeAll(layerSql, layerActivity).pipe(
      Layer.provideMerge(
        Layer.effect(Room)(Effect.flatMap(ActionDurableObject.name, decodeRoom))
      )
    ),
  routes: roomRoutes,
  tasks: { lobby: tellLobby },
  alarm: () =>
    Activity.use((activity) =>
      activity.changing(MessageStore.use((store) => store.expire))
    ),
}) {}

export class ChatLobby extends ActionDurableObject.make({
  services: () => layerKvPreviews,
  routes: lobbyRoutes,
  calls: lobbyCalls,
}) {}

const served = HttpRouter.toWebHandler(
  workerRoutes.pipe(
    Layer.provide(layerLobbyHost),
    Layer.provide(HttpServer.layerServices)
  )
);

const isRoomName = Schema.is(DemoRoomName);

export default {
  async fetch(request: Request, env: Cloudflare.Env) {
    const url = new URL(request.url);

    const room =
      /^\/rooms\/(?<room>[^/]+)\/rpc$/u.exec(url.pathname)?.groups?.room ?? "";

    if (url.pathname === "/lobby/rpc" || isRoomName(room)) {
      url.pathname = "/rpc";

      const object = isRoomName(room)
        ? env.CHAT_ROOM.getByName(room)
        : env.CHAT_LOBBY.getByName("lobby");

      return await object.fetch(new Request(url, request));
    }

    return await served.handler(request);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
