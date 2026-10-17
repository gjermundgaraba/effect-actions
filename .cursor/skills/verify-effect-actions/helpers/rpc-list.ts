import { NodeRuntime, NodeSocket } from "@effect/platform-node";
import { Duration, Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { Rpc } from "../../../../examples/kitchen-sink/src/Rpc.js";

// One WebSocket call of listIssues. A page uses the browser's WebSocket and lets the
// browser attach the session cookie. This script is Node, so it uses Node's WebSocket,
// as examples/live-rpc/src/client.ts does, and sends the cookie on the call.
const url = process.env.TRACKER_RPC_URL;
const session = process.env.TRACKER_SESSION ?? "ada-at-acme";

if (url === undefined || url === "") {
  throw new Error("TRACKER_RPC_URL is not set");
}

const protocol = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(Socket.layerWebSocket(url)),
  Layer.provide(RpcSerialization.layerJson),
  Layer.provide(NodeSocket.layerWebSocketConstructor),
);

const program = Effect.gen(function* () {
  const tracker = yield* ActionRpc.client(Rpc);
  const issues = yield* tracker.listIssues({ limit: 20 }).pipe(
    RpcClient.withHeaders({ cookie: `tracker_session=${session}` }),
    Effect.timeoutOrElse({
      duration: Duration.seconds(8),
      orElse: () => Effect.die("listIssues over the WebSocket did not answer within 8 seconds"),
    }),
  );

  yield* Effect.sync(() => {
    process.stdout.write(`${JSON.stringify(issues)}\n`);
  });
});

program.pipe(Effect.scoped, Effect.provide(protocol), NodeRuntime.runMain);
