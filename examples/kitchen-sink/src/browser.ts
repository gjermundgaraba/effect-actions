import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { Rpc } from "./Rpc.js";

// Entrypoint of the web app, an Effect program in a page. It imports the RPC binding and
// nothing of the server. Its client has the methods of `ActionHttp.client`, over one socket.
export const board = Effect.gen(function* () {
  const tracker = yield* ActionRpc.client(Rpc);

  const me = yield* tracker.whoAmI();
  const { issues } = yield* tracker.listIssues({ status: "open", limit: 50 });

  return { me, issues };
});

// Effect's own client protocol: a WebSocket speaking the server's JSON. The page sends no
// credential itself: the browser attaches the session cookie to the upgrade, and the server
// authenticates every message with it. A client that cannot rely on a cookie, such as a script,
// sends a header on each message instead, with `RpcClient.withHeaders`.
export const protocol = (url: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(url)),
    Layer.provide([RpcSerialization.layerJson, Socket.layerWebSocketConstructorGlobal]),
  );

// `open("wss://tracker.example.com/rpc")`: one run on a socket of its own. The socket belongs
// to the Layer providing the protocol: it opens when that Layer is built, and closes when this
// `Effect.provide` ends. `Effect.scoped` only holds the client. A page that stays connected
// builds the Layer once, such as in a `ManagedRuntime`, and runs its programs in it.
export const open = (url: string) =>
  Effect.runPromise(board.pipe(Effect.scoped, Effect.provide(protocol(url))));
