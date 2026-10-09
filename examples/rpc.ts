import { Layer } from "effect";
import { RpcSerialization, RpcServer } from "effect/rpc";
import * as ActionRpc from "../src/ActionRpc.js";
import { authenticate } from "./authentication.js";
import { status, userActions } from "./handlers.js";
import { Rpc } from "./rpc-binding.js";

// Effect's own RpcServer, at /rpc of the host's router, over a WebSocket, speaking JSON. Each
// protected rpc authenticates every message with `Login`'s verifier, so one connection may
// carry several callers; `status` stays public.
export const layer = ActionRpc.layer(Rpc, [status, userActions]).pipe(
  Layer.provide(RpcServer.layerProtocolWebsocket({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerJson),
  Layer.provide(authenticate),
);
