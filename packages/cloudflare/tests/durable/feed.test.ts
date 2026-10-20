import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Equal, Fiber, Layer, Option, Queue, Schema, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";
import { recordKey } from "../../src/durable/feed.js";
import { FeedCalls, FeedRpcs } from "../support/feed.js";
import { upgradeToRpc } from "../support/socket.js";

let objects = 0;

const fresh = () => env.FED.getByName(`feed-${objects++}`);

const callsOf = (stub: DurableObjectStub<import("../worker.ts").Fed>) =>
  Effect.map(ActionDurableObject.client(FeedCalls), (calls) => calls(() => stub));

const ChunkFrame = Schema.fromJsonString(
  Schema.Struct({
    _tag: Schema.Literal("Chunk"),
    requestId: Schema.Union([Schema.String, Schema.Number]),
    values: Schema.Array(Schema.Int),
  }),
);

const chunkOf = Schema.decodeUnknownOption(ChunkFrame);

type Chunk = typeof ChunkFrame.Type;

const connect = (stub: DurableObjectStub) =>
  Effect.gen(function* () {
    const socket = yield* upgradeToRpc(stub);
    const chunks: Array<Chunk> = [];

    socket.addEventListener("message", ({ data }) => {
      Option.map(chunkOf(data), (chunk) => chunks.push(chunk));
    });

    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Layer.effect(Socket.Socket)(Socket.fromWebSocket(Effect.succeed(socket)))),
        Layer.provide(RpcSerialization.layerJson),
      ),
    );

    const client = yield* RpcClient.make(FeedRpcs).pipe(Effect.provideContext(protocol));

    return { client, chunks };
  });

type Connection = Effect.Success<ReturnType<typeof connect>>;

const subscribe = (
  { client, chunks }: Connection,
  initial: ReadonlyArray<number>,
  key: string | null = null,
) =>
  Effect.gen(function* () {
    const received = yield* Queue.unbounded<number>();

    const fiber = yield* Effect.forkScoped(
      client
        .ticks({ key, initial })
        .pipe(Stream.runForEach((value) => Queue.offer(received, value))),
    );

    const next = (count: number) => Queue.takeN(received, count);

    const first = yield* next(initial.length);

    const requestId = chunks.find((chunk) => Equal.equals(chunk.values, initial))?.requestId;

    const sent = () => chunks.filter((chunk) => chunk.requestId === requestId).length;

    return { first, next, fiber, received, sent };
  });

describe("Feed", () => {
  it.effect("sends a subscriber what a stub call publishes, after its initial values", () =>
    Effect.gen(function* () {
      const stub = fresh();
      const calls = yield* callsOf(stub);
      const subscriber = yield* subscribe(yield* connect(stub), [0]);

      yield* calls.publish({ value: 1, key: null });
      yield* calls.publish({ value: 2, key: null });

      expect(subscriber.first).toEqual([0]);
      expect(yield* subscriber.next(2)).toEqual([1, 2]);
    }).pipe(Effect.scoped),
  );

  it.effect("sends a keyed value only to its key's subscribers, and an unkeyed one to all", () =>
    Effect.gen(function* () {
      const stub = fresh();
      const calls = yield* callsOf(stub);
      const connection = yield* connect(stub);
      const a = yield* subscribe(connection, [10], "a");
      const b = yield* subscribe(connection, [20], "b");
      const everyone = yield* subscribe(connection, [30]);

      yield* calls.publish({ value: 1, key: "a" });
      yield* calls.publish({ value: 2, key: "b" });
      yield* calls.publish({ value: 3, key: null });

      expect(yield* a.next(2)).toEqual([1, 3]);
      expect(yield* b.next(2)).toEqual([2, 3]);
      expect(yield* everyone.next(1)).toEqual([3]);
      expect(everyone.sent()).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "completes a subscriber's stream when the rpc's feed ends, and sends it nothing after",
    () =>
      Effect.gen(function* () {
        const stub = fresh();
        const calls = yield* callsOf(stub);
        const connection = yield* connect(stub);
        const ended = yield* subscribe(connection, [10], "a");
        const going = yield* subscribe(connection, [20], "b");

        yield* calls.end({ key: "a" });
        yield* Fiber.join(ended.fiber);
        yield* calls.publish({ value: 1, key: null });

        expect(yield* going.next(1)).toEqual([1]);
        expect(ended.sent()).toBe(1);
      }).pipe(Effect.scoped),
  );

  it.effect("sends nothing more to a subscriber whose client interrupted its stream", () =>
    Effect.gen(function* () {
      const stub = fresh();
      const calls = yield* callsOf(stub);
      const connection = yield* connect(stub);
      const interrupted = yield* subscribe(connection, [10]);
      const kept = yield* subscribe(connection, [20]);

      yield* Fiber.interrupt(interrupted.fiber);
      yield* connection.client.ping();
      yield* calls.publish({ value: 1, key: null });

      expect(yield* kept.next(1)).toEqual([1]);
      expect(interrupted.sent()).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("sends nothing more to a subscriber whose socket the runtime reported closed", () =>
    Effect.gen(function* () {
      const stub = fresh();
      const calls = yield* callsOf(stub);
      const closing = yield* connect(stub);
      const open = yield* connect(stub);
      const gone = yield* subscribe(closing, [10]);
      const kept = yield* subscribe(open, [20]);

      yield* Effect.promise(() =>
        runInDurableObject(stub, async (instance, state) => {
          const [socket] = state.getWebSockets("effect-actions/socket#1");

          if (socket === undefined) throw new Error("No socket #1");

          await instance.webSocketClose(socket, 1000, "", true);
        }),
      );

      yield* calls.publish({ value: 1, key: null });

      expect(yield* kept.next(1)).toEqual([1]);

      yield* closing.client.ping();

      expect(gone.sent()).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "sends a subscriber made before the object was evicted what a new instance publishes",
    () =>
      Effect.gen(function* () {
        const stub = fresh();
        const calls = yield* callsOf(stub);
        const subscriber = yield* subscribe(yield* connect(stub), [0]);

        yield* Effect.promise(() => evictDurableObject(stub));
        yield* calls.publish({ value: 1, key: null });

        expect(yield* subscriber.next(1)).toEqual([1]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "drops a record no socket holds, as one closed while its object was evicted leaves, when a publish meets it",
    () =>
      Effect.gen(function* () {
        const stub = fresh();
        const calls = yield* callsOf(stub);
        const key = recordKey(99, "0");

        const stored = Effect.promise(() =>
          runInDurableObject(stub, (_, state) => state.storage.get(key)),
        );

        yield* Effect.promise(() =>
          runInDurableObject(stub, (_, state) =>
            state.storage.put(key, { tag: "ticks", key: undefined, requestId: 0 }),
          ),
        );

        expect(yield* stored).toBeDefined();

        yield* calls.publish({ value: 1, key: null });

        expect(yield* stored).toBeUndefined();
      }),
  );
});

const Value = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 }));

const Joining = Schema.Struct({
  initial: Schema.NonEmptyArray(Value),
  at: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
});

it.effect.prop(
  "sends every subscriber its initial values, then each value published from when it joined, in order",
  {
    published: Schema.Array(Value).check(Schema.isBetweenLength(0, 6)),
    subscribers: Schema.Array(Joining).check(Schema.isBetweenLength(1, 4)),
  },
  ({ published, subscribers }) =>
    Effect.gen(function* () {
      const stub = fresh();
      const calls = yield* callsOf(stub);
      const connection = yield* connect(stub);

      const joined: Array<{
        readonly expected: ReadonlyArray<number>;
        readonly first: ReadonlyArray<number>;
        readonly next: (count: number) => Effect.Effect<ReadonlyArray<number>>;
      }> = [];

      for (let index = 0; index <= published.length; index++) {
        for (const { initial, at } of subscribers) {
          if (Math.min(at, published.length) !== index) continue;

          const { first, next } = yield* subscribe(connection, initial);

          joined.push({ expected: [...initial, ...published.slice(index)], first, next });
        }

        const value = published[index];

        if (value !== undefined) yield* calls.publish({ value, key: null });
      }

      for (const { expected, first, next } of joined) {
        const rest = yield* next(expected.length - first.length);

        expect([...first, ...rest]).toEqual(expected);
      }
    }).pipe(Effect.scoped),
  { timeout: 120_000, arbitrary: { runs: 30 } },
);
