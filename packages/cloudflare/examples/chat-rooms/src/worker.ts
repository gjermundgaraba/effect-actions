import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";

import { Activity } from "./chat/activity.js";
import { RoomName } from "./chat/Chat.js";
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

// The rooms for another Worker, over a service binding: a named entrypoint of this one.
export { RoomsEntrypoint } from "./rooms-entrypoint.js";

// Entrypoint, Wrangler's `main`: the composition root of the Worker and of every object. It
// chooses the stores, the room and the stubs, and routes each request.

const decodeRoom = Schema.decodeUnknownEffect(RoomName);

// A room's Durable Object, bound as CHAT_ROOM in wrangler.jsonc under this export's name. Each
// instance builds its services, the store, the room and its activity, then its routes, as it is
// constructed, again after every eviction. The room is the name the Worker reached the object by,
// `getByName(room)`, decoded once there: `ActionDurableObject.name` dies for an object reached by
// an id, and the build fails for a name `RoomName` does not list, each a bug in the Worker. Given
// `rooms`, it refuses a call or a watch whose input names another room. Its `lobby` task tells
// the lobby of each change, on the alarm until the lobby hears. The alarm expires old messages
// and tells the lobby, as an expired message can be the room's latest.
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

// The lobby's Durable Object, bound as CHAT_LOBBY: one for the Worker, named `lobby`, keeping
// every room's preview, which each room tells it of and its pages follow.
export class ChatLobby extends ActionDurableObject.make({
  services: () => layerKvPreviews,
  routes: lobbyRoutes,
  calls: lobbyCalls,
}) {}

// The Worker's own handler, built once, when the module loads, which keeps the lobby's client
// from stranding as `ActionDurableObject.layerStubClient`'s gotchas say: building it does no I/O,
// which a Worker refuses outside a request. `toWebHandler` reads no `MaxBodySize`, so the
// platform limits request bodies.
const served = HttpRouter.toWebHandler(
  workerRoutes.pipe(
    Layer.provide(layerLobbyHost),
    Layer.provide(HttpServer.layerServices)
  )
);

const isRoomName = Schema.is(RoomName);

// A page's socket, `/rooms/<room>/rpc` or `/lobby/rpc`, is its object's `/rpc`: forwarding the
// request forwards its upgrade, and the object answers it. Everything else is the Worker's own,
// the rooms' calls among them, which it sends on to each room's object itself.
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
