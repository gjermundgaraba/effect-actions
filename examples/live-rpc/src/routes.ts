import { Layer } from "effect";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { messages, rooms } from "./chat/handlers.js";
import { ResolveRoom, resolveRoom } from "./chat/room.js";
import { authenticate } from "./identity/verifier.js";
import { Rpc } from "./Rpc.js";

// The binding's rpcs on Effect's own RpcServer, the protected ones behind `Login`'s verifier;
// `listRooms` needs no token.
//
// `ResolveRoom`, listed in `middleware`, provides `CurrentRoom`, which the handlers and
// `authorize` read. Only something that runs per message can, since each message names its own
// room: `Layer.succeed(CurrentRoom, "lobby")` provided here would leave the layer still
// requiring it, in its type.
//
// It still requires three things, each chosen by whoever serves it. The protocol and its
// serialization: server.ts gives it a WebSocket, and a test Effect's HTTP protocol, which
// answers in memory. And `MessageStore`.
export const rpc = ActionRpc.layer(Rpc, [rooms, messages], { middleware: [ResolveRoom] }).pipe(
  Layer.provide([resolveRoom, authenticate]),
);
