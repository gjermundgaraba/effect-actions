import { Layer } from "effect";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { messages, rooms } from "./chat/handlers.js";
import { ResolveRoom, resolveRoom } from "./chat/room.js";
import { authenticate } from "./identity/verifier.js";
import { Rpc } from "./Rpc.js";

// The binding's rpcs on Effect's own RpcServer. A protected rpc authenticates every message
// with `Login`'s verifier, so one connection may carry several callers; `listRooms` needs no
// token.
//
// `middleware` runs around every rpc, inside authentication and before the input is decoded.
// `ResolveRoom` provides `CurrentRoom`, which the handlers and `authorize` read. Only something
// that runs per message can: `Layer.succeed(CurrentRoom, "lobby")` provided here would leave
// the layer still requiring it, in its type.
//
// It still requires three things, each chosen by whoever serves it. The protocol and its
// serialization: server.ts gives it a WebSocket, and a test Effect's HTTP protocol, which
// answers in memory. And `MessageStore`.
export const rpc = ActionRpc.layer(Rpc, [rooms, messages], { middleware: [ResolveRoom] }).pipe(
  Layer.provide([resolveRoom, authenticate]),
);
