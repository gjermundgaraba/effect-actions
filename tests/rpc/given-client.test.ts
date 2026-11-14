import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";

import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import { methodsOf, streamedTransport } from "../../src/rpc/erased.js";
import type { ErasedCall } from "../../src/rpc/erased.js";
import { Login } from "../support/app/binding.js";
import { GetUser, Status, WhoAmI } from "../support/app/contracts.js";

const Rpc = ActionRpc.make([Status, GetUser, WhoAmI], {
  authentication: Login,
});

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
  it.effect("fails a call with what the function fails with", () =>
    Effect.gen(function* () {
      const unreachable: ErasedCall = {
        unary: () => Effect.fail(new Unreachable()),
        stream: () => Stream.fail(new Unreachable()),
      };

      const error = yield* Effect.flip(
        clientThrough(Rpc, unreachable).status()
      );

      expect(error).toStrictEqual(new Unreachable());
    })
  );
});
