import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { RoomName } from "./chat/Chat.js";
import { MessageStore } from "./chat/store.js";
import { layerRoom } from "./platform/object-name.js";
import { layerRooms } from "./platform/room-stubs.js";
import { layerSql } from "./platform/sql-store.js";
import { lobbyRoutes, roomRoutes } from "./routes.js";

// Entrypoint, Wrangler's `main`: the composition root of the Worker and of every room's
// object. It chooses the store and the room, and routes each request.

// A room's Durable Object, bound as CHAT_ROOM in wrangler.jsonc under this export's name. Each
// instance builds its routes when the runtime constructs it, again after every eviction. The
// alarm expires old messages; `post` sets it. It is given the same store layer as the routes,
// so an instance builds the store once for both.
export class ChatRoom extends ActionDurableObject.make({
  routes: roomRoutes.pipe(Layer.provide([layerSql, layerRoom])),
  alarm: () => MessageStore.use((store) => store.expire).pipe(Effect.provide(layerSql)),
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
