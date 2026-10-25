import { env } from "cloudflare:workers";
import { Layer } from "effect";
import { RpcServer } from "effect/rpc";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { LobbyHttp, RoomHttp } from "./Api.js";
import { RoomCalls } from "./chat/Calls.js";
import { messageEvents } from "./chat/events.js";
import { calls, messages, preview } from "./chat/handlers.js";
import { Login } from "./identity/Identity.js";
import { authenticate } from "./identity/verifier.js";
import { LobbyCalls } from "./lobby/Calls.js";
import { previewEvents } from "./lobby/events.js";
import { calls as lobbyHandlers, lobby } from "./lobby/handlers.js";
import { LobbyRpc, protocolVersion, RoomRpc, unsupportedProtocol } from "./Rpc.js";

const room = [preview, messages, messageEvents];

const byRoom = ({ room }: { readonly room: string }) => room;

// Where each room's calls and watches are served: in the room's object, the one each contract's
// key names. worker.ts gives it to the room's class, which then refuses an input naming another
// room, on its socket too; the Worker serves it below.
export const rooms = ActionDurableObject.placed(RoomHttp, {
  preview: byRoom,
  readMessages: byRoom,
  postMessage: byRoom,
  deleteMessage: byRoom,
  "message.posted": byRoom,
});

// One socket route for each object's pages, refusing a page of another version.
const pageSocket = ActionDurableObject.layerWebSocket({
  path: "/rpc",
  protocol: { version: protocolVersion, code: unsupportedProtocol },
});

// What a room's object serves. Its rpcs on WebSockets the runtime holds while the object
// hibernates: a socket keeps the token its upgrade request carried, and each message is
// authenticated with it, or with the message's own. The socket's route refuses a page naming
// another version in its URL, `?protocol=<n>` as browser.ts sends it, with a close code the page's
// client reads as `SocketCloseError` and stops connecting again at, not a 403, which a browser
// reports as a bare 1006 its page connects again after. Its JSON routes, where the Worker sends
// each call and watch on, the token with it: the object authenticates it again, and authorizes.
// It requires `MessageStore` and `Room` at startup: worker.ts chooses them.
export const roomRoutes = Layer.mergeAll(
  ActionRpc.layer(RoomRpc, room).pipe(Layer.provide(pageSocket)),
  ActionHttp.layer(RoomHttp, room),
).pipe(Layer.provide(authenticate));

// What a room's object serves over its stub: its own calls, on Effect's own RpcServer, for the
// Worker and the lobby, which call them with Cloudflare's own RPC. It requires `MessageStore` at
// startup.
export const roomCalls = RpcServer.layer(RoomCalls).pipe(Layer.provide(calls));

// What the lobby's object serves: `PreviewsChanged` on its pages' sockets, a socket a page
// signed out opens too, as nothing on it is protected. It requires `PreviewStore` at startup.
export const lobbyRoutes = ActionRpc.layer(LobbyRpc, [previewEvents]).pipe(
  Layer.provide(pageSocket),
);

// What the lobby's object serves over its stub: its own calls, for the rooms and the Worker. It
// requires `PreviewStore` and `Rooms` at startup.
export const lobbyCalls = RpcServer.layer(LobbyCalls).pipe(Layer.provide(lobbyHandlers));

// The rooms as the Worker serves them, each call sent on to its room's object. The room is read
// from `env` as each call is sent.
const inRooms = ActionDurableObject.reaching(rooms, () => env.CHAT_ROOM);

// What the Worker serves: the rooms' JSON routes and `previews`, which it asks the lobby's object
// for, at `/api`, and all of them at `/mcp`, the actions as tools and `MessagePosted` as an MCP
// event, so one agent's connection reaches every room. Nothing in a Worker outlives a request, so
// the endpoint is request scoped: MCP 2026-07-28 alone, and events by `events/poll`, a poll every
// 30 seconds as events.ts asks. The Worker authenticates each call, and the room's object again.
// It requires `LobbyHost`.
export const workerRoutes = Layer.mergeAll(
  ActionHttp.layer(LobbyHttp, lobby),
  ActionHttp.layer(RoomHttp, inRooms),
  ActionMcp.layerHttp([lobby, ...inRooms], {
    name: "chat-rooms",
    version: "1.0.0",
    authentication: Login,
    requestScoped: true,
  }),
).pipe(Layer.provide(authenticate));
