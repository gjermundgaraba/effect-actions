import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Ref, Schema, Stream } from "effect";
import { RpcClientError } from "effect/rpc";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";

class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}

const dropped = new RpcClientError.RpcClientError({
  reason: new RpcClientError.RpcClientDefect({ message: "The socket dropped.", cause: null }),
});

const told = <E>(stream: Stream.Stream<number, E>) =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<string>>([]);
    const tell = (event: string) => Ref.update(events, (held) => [...held, event]);
    const ended = yield* Deferred.make<Exit.Exit<void, E>>();

    yield* ActionRpc.follow(stream, {
      opened: tell("opened"),
      message: (value) => tell(`message ${value}`),
      closed: (exit) => Effect.andThen(tell("closed"), Deferred.succeed(ended, exit)),
    });

    return { events: yield* Ref.get(events), exit: yield* Deferred.await(ended) };
  });

describe("ActionRpc.follow", () => {
  it.effect("tells opened at the first value, each value in order, then closed with the exit", () =>
    Effect.gen(function* () {
      const { events, exit } = yield* told(Stream.make(1, 2, 3));

      expect(events).toEqual(["opened", "message 1", "message 2", "message 3", "closed"]);
      expect(exit).toEqual(Exit.void);
    }),
  );

  it.effect("never tells opened for a stream ending before its first value", () =>
    Effect.gen(function* () {
      const { events } = yield* told(Stream.empty);

      expect(events).toEqual(["closed"]);
    }),
  );

  it.effect(
    "tells closed a declared failure, a dropped socket's RpcClientError and a defect, after what was sent",
    () =>
      Effect.gen(function* () {
        const refused = yield* told(Stream.concat(Stream.make(1), Stream.fail(new Refused())));
        const drop = yield* told(Stream.fail(dropped));
        const undecodable = yield* told(Stream.die(new Error("A chunk that does not decode.")));

        expect(refused.events).toEqual(["opened", "message 1", "closed"]);
        expect(Exit.findErrorOption(refused.exit)).toEqual(
          Exit.findErrorOption(Exit.fail(new Refused())),
        );
        expect(Exit.isFailure(drop.exit) && Cause.squash(drop.exit.cause)).toBe(dropped);
        expect(Exit.isFailure(undecodable.exit) && Cause.hasDies(undecodable.exit.cause)).toBe(
          true,
        );
      }),
  );

  it.effect("tells closed an interrupt cause the stream itself fails with", () =>
    Effect.gen(function* () {
      const { exit } = yield* told(Stream.failCause(Cause.interrupt()));

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
    }),
  );

  it.effect("runs no closed when the follow itself is interrupted, as a page stopping", () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<ReadonlyArray<string>>([]);
      const tell = (event: string) => Ref.update(events, (held) => [...held, event]);
      const first = yield* Deferred.make<void>();

      const fiber = yield* Effect.forkChild(
        ActionRpc.follow(Stream.concat(Stream.make(1), Stream.never), {
          opened: tell("opened"),
          message: (value) =>
            Effect.andThen(tell(`message ${value}`), Deferred.succeed(first, undefined)),
          closed: () => tell("closed"),
        }),
      );

      yield* Deferred.await(first);
      yield* Fiber.interrupt(fiber);

      expect(yield* Ref.get(events)).toEqual(["opened", "message 1"]);
    }),
  );
});
