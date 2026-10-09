import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import * as ActionRpc from "../src/ActionRpc.js";
import { Rpc } from "./rpc-binding.js";

// A browser WebSocket sets no header on its upgrade, so the token travels on each message.
const asAlice = RpcClient.withHeaders({ authorization: "Bearer alice" });

// The methods of `ActionHttp.client`, over one connection.
export const lookup = Effect.gen(function* () {
  const client = yield* ActionRpc.client(Rpc);

  const status = yield* client.status();
  const user = yield* client.getUser({ id: "1" }).pipe(asAlice);
  const identity = yield* client.whoAmI().pipe(asAlice);

  return { status, user, identity };
});

// Effect's own client protocol: a WebSocket, speaking the server's JSON.
export const protocol = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(Socket.layerWebSocket("ws://127.0.0.1:3000/rpc")),
  Layer.provide([RpcSerialization.layerJson, Socket.layerWebSocketConstructorGlobal]),
);
