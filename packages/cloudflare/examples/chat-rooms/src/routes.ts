import { Layer } from "effect";
import { RpcServer } from "effect/rpc";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { LobbyHttp, RoomHttp } from "./Api.js";
import { RoomCalls } from "./chat/Calls.js";
import { calls, messages, preview, watch } from "./chat/handlers.js";
import { authenticate } from "./identity/verifier.js";
import { lobby } from "./lobby/handlers.js";
import { protocolVersion, RoomRpc, unsupportedProtocol } from "./Rpc.js";

const room = [preview, messages];

// What a room's object serves. Its rpcs on WebSockets the runtime holds while the object
// hibernates: a socket keeps the token its upgrade request carried, and each message is
// authenticated with it, or with the message's own. The socket's route refuses a page naming
// another version in its URL, `?protocol=<n>` as browser.ts sends it, with a close code the page's
// client reads as `SocketCloseError` and stops connecting again at, not a 403, which a browser
// reports as a bare 1006 its page connects again after. `watch`'s handler is the host's, as an
// Effect rpc's is. Its JSON routes at `/api/<action>`. It requires `MessageStore`
// and `Room` at startup: worker.ts chooses them.
export const roomRoutes = Layer.mergeAll(
  ActionRpc.layer(RoomRpc, room).pipe(
    Layer.provide(watch),
    Layer.provide(
      ActionDurableObject.layerWebSocket({
        path: "/rpc",
        protocol: { version: protocolVersion, code: unsupportedProtocol },
      }),
    ),
  ),
  ActionHttp.layer(RoomHttp, room),
).pipe(Layer.provide(authenticate));

// What a room's object serves over its stub: its own calls, on Effect's own RpcServer, for the
// Worker, which calls them with Cloudflare's own RPC. It requires `MessageStore` at startup.
export const roomCalls = RpcServer.layer(RoomCalls).pipe(Layer.provide(calls));

// What the Worker serves itself: the lobby, which asks the rooms' objects. It requires `Rooms`.
export const lobbyRoutes = ActionHttp.layer(LobbyHttp, lobby);
