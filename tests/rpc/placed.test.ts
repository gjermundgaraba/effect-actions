import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import * as Testing from "../../src/testing/Testing.js";
import { authenticate } from "../support/app/authentication.js";
import { Login } from "../support/app/binding.js";
import { GetUser } from "../support/app/contracts.js";
import { Counted, target } from "../support/placed.js";

const Rpc = ActionRpc.make([GetUser, Counted], { authentication: Login });

describe("ActionRpc.layer serving placed contracts", () => {
  it.live(
    "answers a placed action and follows a placed event as the server reached answers them, with the message's headers",
    () =>
      Effect.gen(function* () {
        const reached = target();

        const answered = yield* Effect.gen(function* () {
          const client = yield* ActionRpc.client(Rpc);

          return {
            user: yield* client.getUser({ id: "1" }),
            counts: yield* client.watch(Counted).pipe(Stream.take(1), Stream.runCollect),
          };
        }).pipe(
          RpcClient.withHeaders({ authorization: "Bearer alice", "x-trace": "t1" }),
          Effect.scoped,
          Effect.provide(
            RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
              Layer.provide(RpcSerialization.layerNdjson),
              Layer.provide(
                Testing.layer(
                  ActionRpc.layer(Rpc, reached.placed).pipe(
                    Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
                    Layer.provide(RpcSerialization.layerNdjson),
                    Layer.provide(authenticate),
                  ),
                ),
              ),
            ),
          ),
        );

        expect(answered.user).toEqual({ id: "1", name: "Ada" });
        expect(answered.counts.map((item) => (item._tag === "Gap" ? "gap" : item.data))).toEqual([
          { count: 0 },
        ]);
        expect(
          reached.requests.map(({ url, headers }) => [
            url,
            headers.get("authorization"),
            headers.get("x-trace"),
          ]),
        ).toEqual([
          ["http://localhost/api/getUser", "Bearer alice", "t1"],
          ["http://localhost/api/events/count.changed", "Bearer alice", "t1"],
        ]);
      }),
  );
});
