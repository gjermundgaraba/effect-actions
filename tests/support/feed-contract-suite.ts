import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Queue, type Scope, Stream } from "effect";
import type { RpcClient, RpcClientError } from "effect/rpc";
import { type Controls, NoInitial, type Streams } from "./feed-contract.js";

export interface FeedServer {
  readonly streams: RpcClient.FromGroup<typeof Streams, RpcClientError.RpcClientError>;
  readonly controls: RpcClient.FromGroup<typeof Controls, RpcClientError.RpcClientError>;
}

const following = <E>(stream: Stream.Stream<number, E>) =>
  Effect.gen(function* () {
    const received = yield* Queue.unbounded<number>();

    const fiber = yield* Effect.forkScoped(
      Stream.runForEach(stream, (value) => Queue.offer(received, value)),
    );

    return {
      next: (count: number) => Effect.map(Queue.takeN(received, count), (values) => [...values]),
      ended: Effect.map(Effect.zip(Fiber.await(fiber), Queue.clear(received)), ([exit, rest]) => ({
        exit,
        rest: [...rest],
      })),
    };
  });

const at = (key: string | null, initial: ReadonlyArray<number>) => ({
  key,
  initial,
  hold: false,
  fail: false,
});

const refusal =
  "serves one definition of each rpc tag, and a second definition of ticks reached it";

/**
 * The `Feed` contract both implementations keep, as one suite run against each: `serve` gives a
 * client of the stream rpcs and one of the controls, over one built feed.
 *
 * Left to each layer's own tests, as the two differ:
 * - how values are chunked: both send `initial` as one chunk, but the memory feed may batch queued publications into one, where the durable feed sends each publish on its own, so values are read, never chunks;
 * - where a value published while `initial` is read arrives, before it, in it or both: that rule is a set;
 * - how long a second definition is refused, the memory feed for the layer's life and the durable feed while a subscriber of the first is live in its instance: it is asserted with one live;
 * - an operator on `subscribe`'s stream, which sees no value on the durable feed even live, its values going to the socket.
 */
export const feedContract = (name: string, serve: Effect.Effect<FeedServer, never, Scope.Scope>) =>
  describe(`${name} keeps the Feed contract`, () => {
    it.effect("sends a subscriber its initial values, then each value of its rpc, in order", () =>
      Effect.gen(function* () {
        const { streams, controls } = yield* serve;
        const subscriber = yield* following(streams.ticks(at(null, [1, 2])));

        expect(yield* subscriber.next(2)).toEqual([1, 2]);

        for (const value of [3, 4, 5]) yield* controls.publish({ to: "ticks", value, key: null });

        yield* controls.publish({ to: "tocks", value: 9, key: null });
        yield* controls.end({ to: null, key: null });

        expect(yield* subscriber.ended).toEqual({ exit: Exit.void, rest: [3, 4, 5] });
      }).pipe(Effect.scoped),
    );

    it.effect("sends a value published while initial is read at least once", () =>
      Effect.gen(function* () {
        const { streams, controls } = yield* serve;
        const subscriber = yield* following(streams.ticks({ ...at(null, [1]), hold: true }));

        yield* controls.reading();
        yield* controls.publish({ to: "ticks", value: 2, key: null });
        yield* controls.release();

        const first = yield* subscriber.next(1);

        yield* controls.publish({ to: "ticks", value: 3, key: null });
        yield* controls.end({ to: null, key: null });

        const { exit, rest } = yield* subscriber.ended;

        expect(exit).toEqual(Exit.void);
        expect(new Set([...first, ...rest])).toEqual(new Set([1, 2, 3]));
      }).pipe(Effect.scoped),
    );

    it.effect("ends a subscriber whose initial fails with its failure", () =>
      Effect.gen(function* () {
        const { streams } = yield* serve;
        const subscriber = yield* following(streams.ticks({ ...at(null, [1]), fail: true }));
        const { exit, rest } = yield* subscriber.ended;

        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(NoInitial);
        expect(rest).toEqual([]);
      }).pipe(Effect.scoped),
    );

    it.effect("ends the subscribers of the rpc an end names, alone", () =>
      Effect.gen(function* () {
        const { streams, controls } = yield* serve;
        const ticking = yield* following(streams.ticks(at(null, [1])));
        const tocking = yield* following(streams.tocks({ initial: [1] }));

        yield* ticking.next(1);
        yield* tocking.next(1);
        yield* controls.end({ to: "ticks", key: null });

        const ended = yield* ticking.ended;

        yield* controls.publish({ to: "tocks", value: 7, key: null });
        yield* controls.end({ to: null, key: null });

        expect(ended).toEqual({ exit: Exit.void, rest: [] });
        expect(yield* tocking.ended).toEqual({ exit: Exit.void, rest: [7] });
      }).pipe(Effect.scoped),
    );

    it.effect(
      "sends a value or an end naming a key to that key's subscribers alone, one naming none to all",
      () =>
        Effect.gen(function* () {
          const { streams, controls } = yield* serve;
          const a = yield* following(streams.ticks(at("a", [0])));
          const b = yield* following(streams.ticks(at("b", [0])));
          const none = yield* following(streams.ticks(at(null, [0])));

          for (const subscriber of [a, b, none]) yield* subscriber.next(1);

          yield* controls.publish({ to: "ticks", value: 1, key: "a" });
          yield* controls.end({ to: "ticks", key: "a" });

          const endedA = yield* a.ended;

          yield* controls.publish({ to: "ticks", value: 2, key: null });
          yield* controls.end({ to: null, key: null });

          expect(endedA).toEqual({ exit: Exit.void, rest: [1] });
          expect(yield* b.ended).toEqual({ exit: Exit.void, rest: [2] });
          expect(yield* none.ended).toEqual({ exit: Exit.void, rest: [2] });
        }).pipe(Effect.scoped),
    );

    it.effect("ends every subscriber of every rpc at end()", () =>
      Effect.gen(function* () {
        const { streams, controls } = yield* serve;

        const subscribers = [
          yield* following(streams.ticks(at("a", [1]))),
          yield* following(streams.tocks({ initial: [1] })),
          yield* following(streams["other.ticks"](at(null, [1]))),
        ];

        for (const subscriber of subscribers) yield* subscriber.next(1);

        yield* controls.end({ to: null, key: null });

        for (const subscriber of subscribers) {
          expect(yield* subscriber.ended).toEqual({ exit: Exit.void, rest: [] });
        }
      }).pipe(Effect.scoped),
    );

    it.effect(
      "sends nothing to a subscriber an end reaches before its initial read completes",
      () =>
        Effect.gen(function* () {
          const { streams, controls } = yield* serve;
          const subscriber = yield* following(streams.ticks({ ...at(null, [1]), hold: true }));

          yield* controls.reading();
          yield* controls.end({ to: "ticks", key: null });
          yield* controls.release();

          expect(yield* subscriber.ended).toEqual({ exit: Exit.void, rest: [] });
        }).pipe(Effect.scoped),
    );

    it.effect("keeps a prefixed rpc apart from the rpc it copies", () =>
      Effect.gen(function* () {
        const { streams, controls } = yield* serve;
        const plain = yield* following(streams.ticks(at(null, [0])));
        const prefixed = yield* following(streams["other.ticks"](at(null, [0])));

        yield* plain.next(1);
        yield* prefixed.next(1);
        yield* controls.publish({ to: "ticks", value: 1, key: null });
        yield* controls.publish({ to: "other.ticks", value: 2, key: null });
        yield* controls.end({ to: null, key: null });

        expect(yield* plain.ended).toEqual({ exit: Exit.void, rest: [1] });
        expect(yield* prefixed.ended).toEqual({ exit: Exit.void, rest: [2] });
      }).pipe(Effect.scoped),
    );

    it.effect(
      "refuses a second definition of a tag with a subscriber of the first live, sending it nothing",
      () =>
        Effect.gen(function* () {
          const { streams, controls } = yield* serve;
          const subscriber = yield* following(streams.ticks(at(null, [0])));

          yield* subscriber.next(1);

          const foreign = yield* controls.publishForeign({ value: "foreign" });

          yield* controls.publish({ to: "ticks", value: 1, key: null });
          yield* controls.end({ to: null, key: null });

          expect(foreign).toContain(refusal);
          expect(yield* subscriber.ended).toEqual({ exit: Exit.void, rest: [1] });
        }).pipe(Effect.scoped),
    );
  });
