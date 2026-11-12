import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";

import * as Action from "../../src/contract/Action.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import {
  erasedOf,
  methodsOf,
  streamedTransport,
} from "../../src/rpc/erased.js";
import type { ErasedCall } from "../../src/rpc/erased.js";
import * as Testing from "../../src/testing/Testing.js";
import { authenticate } from "../support/app/authentication.js";
import { Login } from "../support/app/binding.js";
import {
  GetUser,
  Status,
  UserNotFound,
  WhoAmI,
} from "../support/app/contracts.js";
import { status, userActions } from "../support/app/handlers.js";
import { Users } from "../support/app/users.js";

const Rpc = ActionRpc.make([Status, GetUser, WhoAmI], {
  authentication: Login,
});

const routes = ActionRpc.layer(Rpc, [status, userActions]).pipe(
  Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provide(authenticate)
);

const served = Layer.provideMerge(
  RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(Testing.layer(routes))
  ),
  Users.layerMemory
);

const signedInAs = (token: string) =>
  RpcClient.withHeaders({ authorization: `Bearer ${token}` });

function clientThrough<const B extends ActionRpc.Any>(
  binding: B,
  call: ErasedCall
): ActionRpc.Client<B>;
function clientThrough(binding: ActionRpc.Any, call: ErasedCall): object {
  return methodsOf(binding, call, streamedTransport(false));
}

class Unreachable extends Schema.TaggedError<
  Unreachable,
  { readonly brand: unique symbol }
>()("Unreachable", {}) {}

describe("methodsOf over a given client function", () => {
  it.effect(
    "answers through the function, with each call's headers and declared errors",
    () =>
      Effect.gen(function* () {
        const call = yield* RpcClient.make(
          erasedOf(Rpc.actions, Rpc.events, "stream"),
          {
            flatten: true,
          }
        );

        const client = clientThrough(Rpc, call);

        const answer = yield* client.status();

        const actor = yield* client.whoAmI().pipe(signedInAs("alice"));

        const missing = yield* Effect.flip(
          client.getUser({ id: "9" }).pipe(signedInAs("alice"))
        );

        const refused = yield* Effect.flip(client.whoAmI());

        expect(answer).toStrictEqual({ service: "effect-actions", users: 2 });
        expect(actor).toStrictEqual({ id: "alice", tenantId: "acme" });
        expect(missing).toStrictEqual(new UserNotFound({ id: "9" }));
        expect(refused).toBeInstanceOf(Action.Unauthenticated);
      }).pipe(Effect.scoped, Effect.provide(served))
  );

  it.effect("fails a call with what the function fails with", () =>
    Effect.gen(function* () {
      const unreachable: ErasedCall<Unreachable> = () =>
        Effect.fail(new Unreachable());

      const error = yield* Effect.flip(
        clientThrough(Rpc, unreachable).status()
      );

      expect(error).toStrictEqual(new Unreachable());
    })
  );
});
