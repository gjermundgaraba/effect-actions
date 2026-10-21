import { Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { RoomName } from "./chat/Chat.js";
import { Room } from "./chat/room.js";
import { MessageStore } from "./chat/store.js";
import { layerRooms } from "./platform/room-stubs.js";
import { layerSql } from "./platform/sql-store.js";
import { lobbyRoutes, roomCalls, roomRoutes } from "./routes.js";

// Entrypoint, Wrangler's `main`: the composition root of the Worker and of every room's
// object. It chooses the store and the room, and routes each request.

// A room's Durable Object, bound as CHAT_ROOM in wrangler.jsonc under this export's name. Each
// instance builds its services, the store and the room, then its calls and routes, on its
// first event, again after every eviction. The room is the name the Worker reached the object
// by, `getByName(room)` below: `ActionDurableObject.name` dies for an object reached by an id,
// which would be a bug in the Worker. The alarm expires old messages; `post` sets it. It reads
// the store the instance built for the calls and routes.
export class ChatRoom extends ActionDurableObject.make({
  services: () => Layer.mergeAll(layerSql, Layer.effect(Room)(ActionDurableObject.name)),
  routes: roomRoutes,
  calls: roomCalls,
  alarm: () => MessageStore.use((store) => store.expire),
}) {}

// The lobby's handler, built once, when the module loads: building it does no I/O, which a
// Worker refuses outside a request. `toWebHandler` reads no `MaxBodySize`, so the platform
// limits request bodies.
const lobby = HttpRouter.toWebHandler(
  lobbyRoutes.pipe(Layer.provide(layerRooms), Layer.provide(HttpServer.layerServices)),
);

const isRoomName = Schema.is(RoomName);

// `/rooms/<room>/<path>` is the room's object's `<path>`, its socket's upgrade included:
// forwarding the request forwards its upgrade, and the object answers it. Everything else is
// the lobby's.
export default {
  fetch(request: Request, env: Cloudflare.Env) {
    const url = new URL(request.url);
    const [, room = "", rest = "/"] = /^\/rooms\/([^/]+)(\/.*)?$/u.exec(url.pathname) ?? [];

    if (!isRoomName(room)) return lobby.handler(request);

    url.pathname = rest;

    return env.CHAT_ROOM.getByName(room).fetch(new Request(url, request));
  },
} satisfies ExportedHandler<Cloudflare.Env>;
