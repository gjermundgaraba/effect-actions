import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Equal,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Queue,
  Schema,
  Stream,
} from "effect";
import { RpcClient, RpcGroup, type RpcMessage, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import * as Feed from "@gjermundgaraba/effect-actions/Feed";
import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";
import { recordKey } from "../../src/durable/feed.js";
import { socketIdOf } from "../../src/durable/frames.js";
import { FeedCalls, FeedRpcs, Gate, NoInitial, OtherTicks, Ticks } from "../support/feed.js";
import { pathKey, startupKey } from "../support/moved.js";
import { upgradeTo, upgradeToRpc } from "../support/socket.js";

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

const gated = (
  { client }: Connection,
  gate: "during" | "after" | "long",
  initial: ReadonlyArray<number>,
  failInitial = false,
) =>
  Effect.gen(function* () {
    const received = yield* Queue.unbounded<number>();

    const fiber = yield* Effect.forkScoped(
      client
        .ticks({ key: null, initial, failInitial, gate })
        .pipe(Stream.runForEach((value) => Queue.offer(received, value))),
    );

    return { fiber, next: (count: number) => Queue.takeN(received, count) };
  });

const RequestId = Schema.Union([Schema.String, Schema.Number]);

const Frame = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      _tag: Schema.Literal("Chunk"),
      requestId: RequestId,
      values: Schema.Array(Schema.Int),
    }),
    Schema.Struct({ _tag: Schema.Literal("Exit"), requestId: RequestId }),
  ]),
);

const frameOf = Schema.decodeUnknownOption(Frame);

const opened = (stub: DurableObjectStub, path: string) =>
  Effect.gen(function* () {
    const socket = yield* upgradeTo(stub, `https://object${path}`);
    const frames = yield* Queue.unbounded<typeof Frame.Type>();

    socket.addEventListener("message", ({ data }) => {
      Option.map(frameOf(data), (frame) => Queue.offerUnsafe(frames, frame));
    });

    return {
      send: (message: RpcMessage.FromClientEncoded) =>
        Effect.sync(() => socket.send(JSON.stringify(message))),
      next: Queue.take(frames),
      pending: Queue.size(frames),
    };
  });

const forged = {
  "effect-actions-socket": "guessed 1",
  "effect-actions-socket-path": "/rpc",
};

const onSocketAlone = "subscribes a call over layerWebSocket alone";

const defectOf = Schema.decodeUnknownOption(
  Schema.Struct({ defect: Schema.Struct({ message: Schema.String }) }),
);

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

  it.effect("sends a subscriber what a service built among the object's services publishes", () =>
    Effect.gen(function* () {
      const stub = fresh();
      const calls = yield* callsOf(stub);
      const subscriber = yield* subscribe(yield* connect(stub), [0]);

      yield* calls.announce({ value: 7 });

      expect(yield* subscriber.next(1)).toEqual([7]);
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

  it.effect("sends nothing to a subscriber whose initial values failed", () =>
    Effect.gen(function* () {
      const stub = fresh();
      const calls = yield* callsOf(stub);
      const connection = yield* connect(stub);
      const kept = yield* subscribe(connection, [20]);

      const failed = yield* Effect.flip(
        Stream.runDrain(connection.client.ticks({ key: null, initial: [], failInitial: true })),
      );

      yield* calls.publish({ value: 1, key: null });

      expect(yield* kept.next(1)).toEqual([1]);

      yield* connection.client.ping();

      expect(failed).toBeInstanceOf(NoInitial);
      expect(connection.chunks.length).toBe(kept.sent());
    }).pipe(Effect.scoped),
  );

  it.effect(
    "sends a subscriber its initial values before a value published once they are read",
    () =>
      Effect.gen(function* () {
        const stub = fresh();
        const calls = yield* callsOf(stub);
        const subscriber = yield* gated(yield* connect(stub), "after", [10]);

        yield* calls.publishWhenRead({ value: 99 });

        expect(yield* subscriber.next(2)).toEqual([10, 99]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "sends a subscriber its initial values before a value published once they are read, though reading them outlasts a fiber's turn",
    () =>
      Effect.gen(function* () {
        const stub = fresh();
        const calls = yield* callsOf(stub);
        const subscriber = yield* gated(yield* connect(stub), "long", [10]);

        yield* calls.publishWhenRead({ value: 99 });

        expect(yield* subscriber.next(2)).toEqual([10, 99]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "sends a subscriber a value published while its initial values are read before them",
    () =>
      Effect.gen(function* () {
        const stub = fresh();
        const calls = yield* callsOf(stub);
        const subscriber = yield* gated(yield* connect(stub), "during", [10]);

        yield* calls.publishWhenRead({ value: 99 });

        expect(yield* subscriber.next(2)).toEqual([99, 10]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "sends a subscriber a value published while its initial values fail as one chunk, then its failure",
    () =>
      Effect.gen(function* () {
        const stub = fresh();
        const calls = yield* callsOf(stub);
        const connection = yield* connect(stub);
        const subscriber = yield* gated(connection, "during", [10], true);

        yield* calls.publishWhenRead({ value: 99 });

        expect(yield* subscriber.next(1)).toEqual([99]);
        expect(yield* Effect.flip(Fiber.join(subscriber.fiber))).toBeInstanceOf(NoInitial);
        expect(connection.chunks.map((chunk) => chunk.values)).toEqual([[99]]);
      }).pipe(Effect.scoped),
  );

  it.effect("sends no chunk for empty initial values, and keeps the subscriber", () =>
    Effect.gen(function* () {
      const stub = fresh();
      const calls = yield* callsOf(stub);
      const connection = yield* connect(stub);
      const subscriber = yield* gated(connection, "after", []);

      yield* calls.publishWhenRead({ value: 1 });

      expect(yield* subscriber.next(1)).toEqual([1]);

      yield* calls.end({ key: null });
      yield* Fiber.join(subscriber.fiber);

      expect(connection.chunks.map((chunk) => chunk.values)).toEqual([[1]]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "fails a stream rpc called over the stub or HTTP at once, its headers naming a socket or not, sending that socket nothing",
    () =>
      Effect.gen(function* () {
        const stub = fresh();
        const connection = yield* connect(stub);
        const subscriber = yield* subscribe(connection, [10]);

        const overStub = [];

        for (const headers of [[], Object.entries(forged)]) {
          overStub.push(
            yield* Effect.promise(() =>
              stub.effectActionsRpc([
                {
                  _tag: "Request",
                  id: "0",
                  tag: "ticks",
                  payload: { key: null, initial: [42] },
                  headers,
                },
              ]),
            ),
          );
        }

        const overHttp = yield* Effect.flatMap(RpcClient.make(FeedRpcs), (client) =>
          Effect.exit(
            Stream.runDrain(client.ticks({ key: null, initial: [42] }, { headers: forged })),
          ),
        ).pipe(
          Effect.provide(
            RpcClient.layerProtocolHttp({ url: "https://object/http" }).pipe(
              Layer.provide(RpcSerialization.layerNdjson),
              Layer.provide(ActionDurableObject.layerHttpClient(stub)),
            ),
          ),
        );

        yield* connection.client.ping();

        const refusals = overStub.map((answer) =>
          answer
            .flatMap((frame) => Option.toArray(defectOf(frame)))
            .map(({ defect }) => defect.message),
        );

        expect(refusals).toEqual([
          [expect.stringContaining(onSocketAlone)],
          [expect.stringContaining(onSocketAlone)],
        ]);
        expect(Exit.isFailure(overHttp) && Cause.pretty(overHttp.cause)).toContain(onSocketAlone);
        expect(connection.chunks.length).toBe(subscriber.sent());
      }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps a numeric and a string request id of one socket apart, interrupts included",
    () =>
      Effect.gen(function* () {
        const stub = fresh();
        const calls = yield* callsOf(stub);
        const socket = yield* opened(stub, "/rpc");
        const payload = { key: null, initial: [10] };

        yield* socket.send({ _tag: "Request", id: 1, tag: "ticks", payload, headers: [] });
        yield* socket.send({ _tag: "Request", id: "1", tag: "ticks", payload, headers: [] });

        const initial = [yield* socket.next, yield* socket.next];

        yield* calls.publish({ value: 7, key: null });

        const published = [yield* socket.next, yield* socket.next];

        yield* socket.send({ _tag: "Interrupt", requestId: 1 });
        yield* socket.send({ _tag: "Request", id: 2, tag: "ping", payload: null, headers: [] });

        const settled = [yield* socket.next, yield* socket.next];

        yield* calls.publish({ value: 8, key: null });

        expect(initial).toEqual([
          { _tag: "Chunk", requestId: 1, values: [10] },
          { _tag: "Chunk", requestId: "1", values: [10] },
        ]);
        expect(published).toEqual([
          { _tag: "Chunk", requestId: 1, values: [7] },
          { _tag: "Chunk", requestId: "1", values: [7] },
        ]);
        expect(settled).toEqual(
          expect.arrayContaining([
            { _tag: "Exit", requestId: 1 },
            { _tag: "Exit", requestId: 2 },
          ]),
        );
        expect(yield* socket.next).toEqual({ _tag: "Chunk", requestId: "1", values: [8] });
      }).pipe(Effect.scoped),
  );

  it.effect(
    "refuses a subscribe, a publish and an end on an object serving two socket paths, naming both, though one alone has subscribers, sending nothing",
    () =>
      Effect.gen(function* () {
        const stub = env.TWO_PATHS.getByName(`two-paths-${objects++}`);
        const calls = yield* callsOf(stub);
        const socket = yield* upgradeTo(stub, "https://object/other");
        const received: Array<string> = [];

        socket.addEventListener("message", ({ data }) => {
          if (Predicate.isString(data)) received.push(data);
        });

        yield* Effect.promise(() =>
          runInDurableObject(stub, async (_, state) => {
            const [other] = state.getWebSockets("effect-actions/rpc:/other");

            if (other === undefined) throw new Error("No socket on /other");

            await state.storage.put(recordKey(socketIdOf(state.getTags(other)), 1), {
              tag: "ticks",
              key: undefined,
              requestId: 1,
            });
          }),
        );

        socket.send(
          JSON.stringify({
            _tag: "Request",
            id: 2,
            tag: "ticks",
            payload: { initial: [20] },
            headers: [],
          }),
        );

        const published = yield* Effect.exit(calls.publish({ value: 1, key: null }));
        const ended = yield* Effect.exit(calls.end({ key: null }));
        const refusal = "serves /rpc and /other";

        for (const exit of [published, ended]) {
          expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(refusal);
        }

        yield* Effect.promise(() => vi.waitUntil(() => received.length > 0, { timeout: 5_000 }));

        expect(received).toEqual([expect.stringContaining(refusal)]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "sends a socket accepted on a path the rebuilt object no longer serves nothing, dropping its record, and the path it serves what is published",
    () =>
      Effect.gen(function* () {
        const stub = env.MOVED.getByName(`moved-${objects++}`);

        const follow = (id: string) =>
          ({ _tag: "Request", id, tag: "follow", payload: {}, headers: [] }) as const;

        const old = yield* opened(stub, "/a");

        yield* old.send(follow("old"));

        expect(yield* old.next).toEqual({ _tag: "Chunk", requestId: "old", values: [10] });

        yield* Effect.promise(() =>
          runInDurableObject(stub, (_, state) => state.storage.put(pathKey, "/b")),
        );
        yield* Effect.promise(() => evictDurableObject(stub));

        const current = yield* opened(stub, "/b");

        yield* current.send(follow("current"));

        expect(yield* current.next).toEqual({ _tag: "Chunk", requestId: "current", values: [10] });

        yield* Effect.promise(() => stub.publish(99));

        const records = yield* Effect.promise(() =>
          runInDurableObject(
            stub,
            async (_, state) => (await state.storage.list({ prefix: "effect-actions/feed/" })).size,
          ),
        );

        yield* Effect.promise(() => stub.end());

        expect([yield* current.next, yield* current.next]).toEqual([
          { _tag: "Chunk", requestId: "current", values: [99] },
          { _tag: "Exit", requestId: "current" },
        ]);
        expect(records).toBe(1);
        expect(yield* old.pending).toBe(0);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "ends only the subscribers of the path the rebuilt object serves, sending a socket accepted on another no exit, and drops both records",
    () =>
      Effect.gen(function* () {
        const stub = env.MOVED.getByName(`moved-${objects++}`);

        const follow = (id: string) =>
          ({ _tag: "Request", id, tag: "follow", payload: {}, headers: [] }) as const;

        const old = yield* opened(stub, "/a");

        yield* old.send(follow("old"));

        expect(yield* old.next).toEqual({ _tag: "Chunk", requestId: "old", values: [10] });

        yield* Effect.promise(() =>
          runInDurableObject(stub, (_, state) => state.storage.put(pathKey, "/b")),
        );
        yield* Effect.promise(() => evictDurableObject(stub));

        const current = yield* opened(stub, "/b");

        yield* current.send(follow("current"));

        expect(yield* current.next).toEqual({ _tag: "Chunk", requestId: "current", values: [10] });

        yield* Effect.promise(() => stub.end());

        const records = yield* Effect.promise(() =>
          runInDurableObject(
            stub,
            async (_, state) => (await state.storage.list({ prefix: "effect-actions/feed/" })).size,
          ),
        );

        expect(yield* current.next).toEqual({ _tag: "Exit", requestId: "current" });
        expect(records).toBe(0);
        expect(yield* old.pending).toBe(0);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "refuses a publish while the services build, before the routes register their path, and sends one once they are built",
    () =>
      Effect.gen(function* () {
        const stub = env.MOVED.getByName(`moved-${objects++}`);
        const socket = yield* opened(stub, "/a");

        yield* socket.send({ _tag: "Request", id: 1, tag: "follow", payload: {}, headers: [] });

        expect(yield* socket.next).toEqual({ _tag: "Chunk", requestId: 1, values: [10] });

        yield* Effect.promise(() => evictDurableObject(stub));
        yield* Effect.promise(() => stub.publish(99));

        const startup = yield* Effect.promise(() =>
          runInDurableObject(stub, (_, state) => state.storage.get(startupKey)),
        );

        expect(yield* socket.next).toEqual({ _tag: "Chunk", requestId: 1, values: [99] });
        expect(String(startup)).toContain("none is registered yet");
      }).pipe(Effect.scoped),
  );

  it("holds one rpc per tag in a group, a later one replacing an earlier", () => {
    const group = RpcGroup.make(Ticks, OtherTicks);

    expect([...group.requests.values()]).toEqual([OtherTicks]);
  });

  it.effect("gives a handler over the socket no header naming its socket", () =>
    Effect.gen(function* () {
      const { client } = yield* connect(fresh());

      expect(
        (yield* client.headerNames()).filter((name) => name.startsWith("effect-actions")),
      ).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "ends a live subscriber's stream through the server, running its finalizers, each time it subscribes again",
    () =>
      Effect.gen(function* () {
        const stub = fresh();
        const calls = yield* callsOf(stub);
        const connection = yield* connect(stub);

        for (const round of [1, 2, 3]) {
          const subscriber = yield* subscribe(connection, [round]);

          yield* calls.end({ key: null });
          yield* Fiber.join(subscriber.fiber);
        }

        expect(yield* calls.finalized()).toBe(3);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "completes a subscriber ended while its initial values are read, interrupting a read that never returns, sending nothing",
    () =>
      Effect.gen(function* () {
        const stub = fresh();
        const calls = yield* callsOf(stub);
        const connection = yield* connect(stub);
        const subscriber = yield* gated(connection, "during", [10]);

        yield* calls.endWhenRead({ key: null });
        yield* Fiber.join(subscriber.fiber);
        yield* connection.client.ping();

        expect(connection.chunks).toEqual([]);
        expect(yield* calls.finalized()).toBe(1);
      }).pipe(Effect.scoped),
  );

  it.effect("completes a subscriber ended while its initial values encode, sending them not", () =>
    Effect.gen(function* () {
      const stub = fresh();
      const calls = yield* callsOf(stub);
      const connection = yield* connect(stub);

      const subscriber = yield* Effect.forkScoped(Stream.runCollect(connection.client.heldTicks()));

      yield* calls.endWhenEncoding();

      const values = yield* Fiber.join(subscriber);

      yield* connection.client.ping();

      expect(Array.from(values)).toEqual([]);
      expect(connection.chunks).toEqual([]);
      expect(yield* calls.finalized()).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "drops, and never throws for, a socket the object closed before the runtime reported it",
    () =>
      Effect.gen(function* () {
        const stub = fresh();
        const connection = yield* connect(stub);

        yield* subscribe(connection, [10], "kept");
        yield* gated(connection, "during", [20]);

        const left = yield* Effect.promise(() =>
          runInDurableObject(stub, async (instance, state) => {
            await instance.run(
              Effect.flatMap(Effect.service(Gate), ({ read }) => Deferred.await(read)),
            );

            for (const socket of state.getWebSockets("effect-actions/socket#1")) socket.close(1000);

            await instance.run(
              Effect.gen(function* () {
                const feed = yield* Feed.Feed;
                const { released } = yield* Gate;

                yield* feed.end(Ticks, { key: "kept" });
                yield* feed.publish(Ticks, 1);
                yield* Deferred.succeed(released, undefined);
              }),
            );

            return (await state.storage.list({ prefix: "effect-actions/feed/" })).size;
          }),
        );

        expect(left).toBe(0);
      }).pipe(Effect.scoped),
  );

  it.effect("sends a stream rpc whose values encode asynchronously, as its server would", () =>
    Effect.gen(function* () {
      const stub = fresh();
      const calls = yield* callsOf(stub);
      const { client } = yield* connect(stub);
      const received = yield* Queue.unbounded<number>();

      yield* Effect.forkScoped(
        Stream.runForEach(client.slowTicks(), (value) => Queue.offer(received, value)),
      );

      const initial = yield* Queue.take(received);

      yield* calls.publishSlowly({ value: 6 });

      expect([initial, yield* Queue.take(received)]).toEqual([5, 6]);
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

  it.effect(
    "ends every subscriber of every rpc, live or hibernated, before a wipe of the object's storage, and a socket given a closed one's id after it receives only what it asked for",
    () =>
      Effect.gen(function* () {
        const stub = fresh();
        const calls = yield* callsOf(stub);
        const hibernated = yield* connect(stub);

        const slow = yield* Effect.forkScoped(Stream.runCollect(hibernated.client.slowTicks()));

        yield* Effect.promise(() => vi.waitUntil(() => hibernated.chunks.length > 0));
        yield* Effect.promise(() => evictDurableObject(stub));

        const live = yield* subscribe(yield* connect(stub), [20], "b");
        const closing = yield* upgradeTo(stub, "https://object/rpc");

        const records = Effect.promise(() =>
          runInDurableObject(
            stub,
            async (_, state) => (await state.storage.list({ prefix: "effect-actions/" })).size,
          ),
        );

        closing.close(1000);

        yield* Effect.promise(() =>
          vi.waitUntil(async () => (await Effect.runPromise(records)) === 3),
        );

        yield* calls.wipe();

        const ended = {
          slow: Array.from(yield* Fiber.join(slow)),
          live: yield* Fiber.join(live.fiber),
        };

        const left = yield* records;
        const finalized = yield* calls.finalized();

        yield* Effect.promise(() => evictDurableObject(stub));

        const later = yield* connect(stub);
        const subscriber = yield* subscribe(later, [7]);

        const ids = yield* Effect.promise(() =>
          runInDurableObject(stub, (_, state) =>
            state.getWebSockets().map((socket) => socketIdOf(state.getTags(socket))),
          ),
        );

        yield* calls.publish({ value: 8, key: null });

        expect(ended).toEqual({ slow: [5], live: undefined });
        expect(finalized).toBe(1);
        expect(left).toBe(0);
        expect(ids.toSorted((a, b) => a - b)).toEqual([1, 2, 3]);
        expect(subscriber.first).toEqual([7]);
        expect(yield* subscriber.next(1)).toEqual([8]);
        expect(later.chunks.map(({ values }) => values)).toEqual([[7], [8]]);
      }).pipe(Effect.scoped),
  );

  it.effect("drops the records of a socket the runtime reported closed", () =>
    Effect.gen(function* () {
      const stub = fresh();
      const calls = yield* callsOf(stub);
      const closing = yield* connect(stub);
      const open = yield* connect(stub);

      yield* subscribe(closing, [10]);

      const kept = yield* subscribe(open, [20]);

      const records = yield* Effect.promise(() =>
        runInDurableObject(stub, async (instance, state) => {
          const [socket] = state.getWebSockets("effect-actions/socket#1");

          if (socket === undefined) throw new Error("No socket #1");

          const count = async () =>
            (await state.storage.list({ prefix: "effect-actions/feed/" })).size;

          const before = await count();

          await instance.webSocketClose(socket, 1000, "", true);

          return { before, after: await count() };
        }),
      );

      yield* calls.publish({ value: 1, key: null });

      expect(records).toEqual({ before: 2, after: 1 });
      expect(yield* kept.next(1)).toEqual([1]);
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
    "drops a record no socket holds, as one closed while its object was evicted leaves, when a publish meets it, still sending the others",
    () =>
      Effect.gen(function* () {
        const stub = fresh();
        const calls = yield* callsOf(stub);
        const subscriber = yield* subscribe(yield* connect(stub), [10]);
        const key = recordKey(99, 0);

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
        expect(yield* subscriber.next(1)).toEqual([1]);
      }).pipe(Effect.scoped),
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
