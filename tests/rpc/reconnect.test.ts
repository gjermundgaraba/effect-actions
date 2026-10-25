import { describe, expect, it } from "@effect/vitest";
import { Clock, Effect, Fiber, Ref } from "effect";
import { Socket } from "effect/socket";
import { TestClock } from "effect/testing";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";

const closed = (code: number) =>
  new Socket.SocketError({ reason: new Socket.SocketCloseError({ code }) });

const dropped = new Socket.SocketError({
  reason: new Socket.SocketReadError({ cause: new Error("The connection dropped.") }),
});

const attempts = (failures: ReadonlyArray<Socket.SocketError>) =>
  Effect.gen(function* () {
    const at = yield* Ref.make<ReadonlyArray<number>>([]);

    const connect = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const made = yield* Ref.modify(at, (times) => [times.length, [...times, now]]);
      const failure = failures[made];

      if (failure !== undefined) return yield* Effect.fail(failure);
    });

    const fiber = yield* Effect.forkScoped(
      Effect.exit(Effect.retry(connect, ActionRpc.reconnectUntil(4000))),
    );

    yield* TestClock.adjust("1 minute");

    return { exit: yield* Fiber.join(fiber), at: yield* Ref.get(at) };
  });

describe("reconnectUntil", () => {
  it.effect(
    "waits as Effect's default socket policy waits, 500 ms growing by 1.5 to at most 5 s",
    () =>
      Effect.gen(function* () {
        const { exit, at } = yield* attempts(Array.from({ length: 8 }, () => dropped));

        const waits = at.slice(1).map((time, index) => time - (at[index] ?? 0));

        expect(exit._tag).toBe("Success");
        expect(waits).toEqual(
          Array.from({ length: 8 }, (_, retry) => Math.min(500 * 1.5 ** retry, 5000)),
        );
      }).pipe(Effect.scoped),
  );

  it.effect("stops at a close with a code it was given, and connects again after another", () =>
    Effect.gen(function* () {
      const { exit, at } = yield* attempts([closed(1006), closed(4001), closed(4000)]);

      expect(exit).toMatchObject({ _tag: "Failure" });
      expect(at.length).toBe(3);
    }).pipe(Effect.scoped),
  );
});
