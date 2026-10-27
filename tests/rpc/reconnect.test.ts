import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Layer, Ref, Schema, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { TestClock } from "effect/testing";

import * as Action from "../../src/contract/Action.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";

const closed = (code: number) =>
  new Socket.SocketError({ reason: new Socket.SocketCloseError({ code }) });

const dropped = new Socket.SocketError({
  reason: new Socket.SocketReadError({
    cause: new Error("The connection dropped."),
  }),
});

const connecting = (
  codes: readonly number[],
  failures: readonly Socket.SocketError[]
) =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);

    const connect = Effect.gen(function* () {
      const failure =
        failures[yield* Ref.getAndUpdate(attempts, (made) => made + 1)];

      if (failure !== undefined) {
        return yield* failure;
      }
    });

    const fiber = yield* Effect.forkScoped(
      Effect.exit(Effect.retry(connect, ActionRpc.reconnectUntil(...codes)))
    );

    yield* TestClock.adjust("1 hour");

    return {
      exit: yield* Fiber.join(fiber),
      attempts: yield* Ref.get(attempts),
    };
  });

describe("reconnectUntil", () => {
  it.effect(
    "connects again after a drop or a close with another code, until it connects",
    () =>
      Effect.gen(function* () {
        const { exit, attempts } = yield* connecting(
          [4000],
          [dropped, closed(1006), closed(4001)]
        );

        expect(Exit.isSuccess(exit)).toBe(true);
        expect(attempts).toBe(4);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "stops at a close with any code it was given, failing with that close",
    () =>
      Effect.gen(function* () {
        for (const code of [4000, 4001]) {
          const refusal = closed(code);

          const { exit, attempts } = yield* connecting(
            [4000, 4001],
            [dropped, refusal, dropped]
          );

          expect(exit).toStrictEqual(Exit.fail(refusal));
          expect(attempts).toBe(2);
        }
      }).pipe(Effect.scoped)
  );

  it.effect(
    "ends a watch on a close with the code it stops at, its socket opened once",
    () =>
      Effect.gen(function* () {
        const Ticked = Event.make("clock.ticked", {
          description: "The clock ticked.",
          payload: { at: Schema.Int },
          caller: Action.Anyone,
        });

        let opened = 0;

        const refusing = Socket.make({
          reader: Effect.sync(() => {
            opened += 1;

            return {
              pull: Effect.andThen(
                Effect.sleep("1 millis"),
                Effect.fail(closed(4001))
              ),
              upgrade: () => Effect.void,
            };
          }),
          writer: Effect.succeed({
            write: () => Effect.void,
            writeAll: () => Effect.void,
          }),
        });

        const protocol = RpcClient.layerProtocolSocket({
          retryPolicy: ActionRpc.reconnectUntil(4001),
        }).pipe(
          Layer.provide(Layer.succeed(Socket.Socket, refusing)),
          Layer.provide(RpcSerialization.layerJson)
        );

        const fiber = yield* Effect.flatMap(
          ActionRpc.client(ActionRpc.make([Ticked])),
          (client) => Effect.exit(Stream.runDrain(client.watch(Ticked, {})))
        ).pipe(Effect.scoped, Effect.provide(protocol), Effect.forkChild);

        yield* TestClock.adjust("10 minutes");

        const exit = yield* Fiber.join(fiber);

        expect(Exit.isFailure(exit) && String(exit.cause)).toContain("4001");
        expect(opened).toBe(1);
      })
  );
});
