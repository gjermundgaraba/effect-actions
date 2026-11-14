import { expect, layer } from "@effect/vitest";
import { Arbitrary, Effect, Layer, Schema } from "effect";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";

import * as ActionEntity from "../../src/entity/ActionEntity.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import * as Testing from "../../src/testing/Testing.js";
import {
  makeRooms,
  onTestRunner,
  Payload,
  Room,
  RoomRpc,
} from "../support/rooms.js";

const rooms = makeRooms();

const overRpc = RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provide(
    Testing.layer(
      ActionRpc.layer(RoomRpc, rooms.echoing).pipe(
        Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
        Layer.provide(RpcSerialization.layerNdjson)
      )
    )
  )
);

const jsonTextOf = Schema.encodeSync(
  Schema.fromJsonString(Schema.toCodecJson(Payload))
);

layer(Layer.mergeAll(onTestRunner(rooms), overRpc), {
  excludeTestServices: true,
})("ActionEntity on a TestRunner, beside ActionRpc.layer", (it) => {
  it.effect.prop(
    "answers any input as ActionRpc.layer answers it, the payload as JSON carries it",
    [Arbitrary.schema(Payload)],
    ([payload]) =>
      Effect.gen(function* () {
        const lobby = (yield* ActionEntity.client(Room))("lobby");
        const rpc = yield* ActionRpc.client(RoomRpc);

        const input = { room: "lobby", payload };

        const fromEntity = yield* lobby.echo(input);
        const fromRpc = yield* rpc.echo(input);

        expect(jsonTextOf(fromEntity)).toBe(jsonTextOf(fromRpc));
        expect(jsonTextOf(fromEntity)).toBe(jsonTextOf(payload));
      }),
    { timeout: 30_000, arbitrary: { runs: 100 } }
  );
});
