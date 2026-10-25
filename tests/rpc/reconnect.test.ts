import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Ref } from "effect";
import { Socket } from "effect/socket";
import { TestClock } from "effect/testing";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";

const closed = (code: number) =>
  new Socket.SocketError({ reason: new Socket.SocketCloseError({ code }) });

const dropped = new Socket.SocketError({
  reason: new Socket.SocketReadError({ cause: new Error("The connection dropped.") }),
});

const connecting = (codes: ReadonlyArray<number>, failures: ReadonlyArray<Socket.SocketError>) =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);

    const connect = Effect.gen(function* () {
      const failure = failures[yield* Ref.getAndUpdate(attempts, (made) => made + 1)];

      if (failure !== undefined) return yield* Effect.fail(failure);
    });

    const fiber = yield* Effect.forkScoped(
      Effect.exit(Effect.retry(connect, ActionRpc.reconnectUntil(...codes))),
    );

    yield* TestClock.adjust("1 hour");

    return { exit: yield* Fiber.join(fiber), attempts: yield* Ref.get(attempts) };
  });

describe("reconnectUntil", () => {
  it.effect("connects again after a drop or a close with another code, until it connects", () =>
    Effect.gen(function* () {
      const { exit, attempts } = yield* connecting([4000], [dropped, closed(1006), closed(4001)]);

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(attempts).toBe(4);
    }).pipe(Effect.scoped),
  );

  it.effect("stops at a close with any code it was given, failing with that close", () =>
    Effect.gen(function* () {
      for (const code of [4000, 4001]) {
        const refusal = closed(code);
        const { exit, attempts } = yield* connecting([4000, 4001], [dropped, refusal, dropped]);

        expect(exit).toEqual(Exit.fail(refusal));
        expect(attempts).toBe(2);
      }
    }).pipe(Effect.scoped),
  );
});
