import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { authenticate } from "./authentication.js";
import { status, userActions } from "./handlers.js";
import { Rpc } from "./rpc-binding.js";
import { Users } from "./users.js";

// The rpcs over Effect's HTTP protocol, behind their real authentication.
const server = ActionRpc.layer(Rpc, [status, userActions]).pipe(
  Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerJson),
  Layer.provide(authenticate),
);

// The client's protocol posts through `Testing.layer`'s HttpClient, answered in memory.
const protocol = RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
  Layer.provide(RpcSerialization.layerJson),
  Layer.provide(Testing.layer(server)),
  Layer.provideMerge(Users.layerMemory),
);

// Each call carries its caller's token, so one client serves several.
const as = (token: string) => RpcClient.withHeaders({ authorization: `Bearer ${token}` });

const program = Effect.gen(function* () {
  const client = yield* ActionRpc.client(Rpc);
  const rename = client.renameUser({ id: "1", name: "Bea" });

  const refused = yield* Effect.flip(rename.pipe(as("reader"))); // Forbidden
  const signedOut = yield* Effect.flip(client.whoAmI()); // Unauthenticated
  const users = yield* Users;

  return { refused, signedOut, unchanged: yield* users.get("acme", "1") };
});

console.log(await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(protocol))));
