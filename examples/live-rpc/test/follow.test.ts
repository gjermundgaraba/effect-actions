import { describe, expect, it } from "@effect/vitest";
import { Clock, Effect, Exit, Fiber, Ref, Stream } from "effect";
import { RpcClientError } from "effect/rpc";
import { TestClock } from "effect/testing";
import type { Message } from "../src/chat/Chat.js";
import { follow } from "../src/follow.js";

// `follow` against a scripted `watch`: each subscription is the next stream of the script, and
// each call records the id it was asked from and when, on the test clock.
const message = (id: number): Message => ({ id, author: "ada", text: `Message ${id}.` });

const dropped = new RpcClientError.RpcClientError({
  reason: new RpcClientError.RpcClientDefect({ message: "The socket dropped.", cause: null }),
});

const scripted = (script: ReadonlyArray<Stream.Stream<Message, RpcClientError.RpcClientError>>) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<{ readonly from: number; readonly at: number }>>(
      [],
    );

    const told = yield* Ref.make<ReadonlyArray<string>>([]);
    const tell = (event: string) => Ref.update(told, (events) => [...events, event]);

    const watch = (from: number) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis;
          const done = yield* Ref.modify(calls, (made) => [made.length, [...made, { from, at }]]);

          return script[done] ?? Stream.empty;
        }),
      );

    const fiber = yield* Effect.forkScoped(
      follow(watch, 0, {
        opened: tell("opened"),
        message: ({ id }) => tell(`message ${id}`),
        closed: (exit) => tell(Exit.isSuccess(exit) ? "closed" : "failed"),
      }),
    );

    yield* TestClock.adjust("1 minute");
    yield* Fiber.join(fiber);

    return { calls: yield* Ref.get(calls), told: yield* Ref.get(told) };
  });

describe("follow", () => {
  it.effect(
    "subscribes again from the last message the page holds, telling it each message once",
    () =>
      Effect.gen(function* () {
        const { calls, told } = yield* scripted([
          Stream.make(message(1), message(2)).pipe(Stream.concat(Stream.fail(dropped))),
          Stream.make(message(2), message(3)),
        ]);

        expect(calls.map(({ from }) => from)).toEqual([0, 2]);
        expect(told).toEqual(["opened", "message 1", "message 2", "message 3", "closed"]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "waits longer after each drop, and as long as after the first once a subscription sent a message",
    () =>
      Effect.gen(function* () {
        const { calls } = yield* scripted([
          Stream.fail(dropped),
          Stream.fail(dropped),
          Stream.fail(dropped),
          Stream.make(message(1)).pipe(Stream.concat(Stream.fail(dropped))),
        ]);

        const waits = calls.slice(1).map(({ at }, index) => at - (calls[index]?.at ?? 0));

        expect(waits[1]).toBeGreaterThan(waits[0] ?? 0);
        expect(waits[2]).toBeGreaterThan(waits[1] ?? 0);
        expect(waits[3]).toBe(waits[0]);
      }).pipe(Effect.scoped),
  );
});
