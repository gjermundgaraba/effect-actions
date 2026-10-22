import * as v8 from "node:v8";
import * as vm from "node:vm";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Match,
  Queue,
  Ref,
  References,
  Schema,
  Stream,
} from "effect";
import { Rpc, RpcGroup, RpcMessage, RpcMiddleware, RpcSchema, RpcTest } from "effect/rpc";
import * as Feed from "../../src/feed/Feed.js";

class NoInitial extends Schema.TaggedError<NoInitial>()("NoInitial", {}) {}

const Ticks = Rpc.make("ticks", {
  payload: {
    key: Schema.NullOr(Schema.String),
    initial: Schema.Array(Schema.Int),
    read: Schema.Literals(["at once", "held", "failing", "ending"]),
  },
  success: Schema.Int,
  error: NoInitial,
  stream: true,
});

const Others = Rpc.make("others", {
  payload: { key: Schema.NullOr(Schema.String) },
  success: Schema.Int,
  stream: true,
});

const Group = RpcGroup.make(Ticks, Others);

class Gate extends Context.Service<
  Gate,
  {
    readonly reading: Deferred.Deferred<void>;
    readonly released: Deferred.Deferred<void>;
    readonly finalized: Ref.Ref<number>;
  }
>()("tests/feed/Gate") {
  static readonly layer = Layer.effect(Gate)(
    Effect.all({
      reading: Deferred.make<void>(),
      released: Deferred.make<void>(),
      finalized: Ref.make(0),
    }),
  );
}

const handlers = Group.toLayer(
  Effect.gen(function* () {
    const feed = yield* Feed.Feed;
    const { reading, released, finalized } = yield* Gate;

    const counted = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
      Stream.ensuring(
        stream,
        Ref.update(finalized, (count) => count + 1),
      );

    const held = (initial: ReadonlyArray<number>) =>
      Deferred.succeed(reading, undefined).pipe(
        Effect.andThen(Deferred.await(released)),
        Effect.as(initial),
      );

    return Group.of({
      ticks: ({ key, initial, read }, request) =>
        counted(
          feed.subscribe(request, {
            key: key ?? undefined,
            initial: Match.value(read).pipe(
              Match.when("failing", () => Effect.fail(new NoInitial())),
              Match.when("held", () => held(initial)),
              Match.when("ending", () => Effect.as(feed.end(), initial)),
              Match.orElse(() => Effect.succeed(initial)),
            ),
          }),
        ),
      others: ({ key }, request) =>
        counted(feed.subscribe(request, { key: key ?? undefined, initial: [0] })),
    });
  }),
);

const served = handlers.pipe(Layer.provideMerge(Layer.merge(Feed.layer, Gate.layer)));

const client = RpcTest.makeClient(Group);

type Client = Effect.Success<typeof client>;

const follow = <E>(stream: Stream.Stream<number, E>, initial: number) =>
  Effect.gen(function* () {
    const received = yield* Queue.unbounded<number>();

    const fiber = yield* Effect.forkScoped(
      Stream.runForEach(stream, (value) => Queue.offer(received, value)),
    );

    const first = yield* Queue.takeN(received, initial);

    const rest = Effect.andThen(Fiber.join(fiber), Queue.clear(received));

    return { first, rest, fiber };
  });

class Passing extends RpcMiddleware.Service<Passing>()("tests/feed/Passing") {}

const WrappedWatch = Rpc.make("watch", { success: Schema.Int, stream: true });

const PlainWatch = Rpc.make("watch", { success: Schema.Int, stream: true });

const Wrapped = RpcGroup.make(WrappedWatch).middleware(Passing);

const Plain = RpcGroup.make(PlainWatch);

const wrappedServed = Layer.merge(
  Wrapped.toLayer(
    Effect.map(Feed.Feed, (feed) =>
      Wrapped.of({ watch: (_, request) => feed.subscribe(request, { initial: [0] }) }),
    ),
  ),
  Layer.succeed(Passing)((effect) => effect),
);

const plainServed = Plain.toLayer(
  Effect.map(Feed.Feed, (feed) =>
    Plain.of({ watch: (_, request) => feed.subscribe(request, { initial: [0] }) }),
  ),
);

const Held = Rpc.make("held", {
  payload: { failing: Schema.Boolean },
  success: Schema.Struct({ n: Schema.Int }),
  error: NoInitial,
  stream: true,
});

const Holding = RpcGroup.make(Held);

const holdingServed = Holding.toLayer(
  Effect.map(Feed.Feed, (feed) =>
    Holding.of({
      held: ({ failing }, request) =>
        feed.subscribe(request, {
          initial: failing ? Effect.fail(new NoInitial()) : Effect.succeed([{ n: 0 }]),
        }),
    }),
  ),
);

v8.setFlagsFromString("--expose-gc");

const publishHeld = (feed: Feed.Feed["Service"]) =>
  Effect.suspend(() => {
    const value = { n: 1 };

    return Effect.as(feed.publish(Held, value), new WeakRef(value));
  });

const released = (value: WeakRef<object>) =>
  Effect.promise(() => new Promise((resolve) => setImmediate(resolve))).pipe(
    Effect.andThen(
      Effect.sync(() => {
        vm.runInNewContext("gc()");

        return value.deref() === undefined;
      }),
    ),
    Effect.repeat({ until: (done) => done, times: 20 }),
  );

const endedAsRead = (feed: Feed.Feed["Service"]) =>
  Effect.gen(function* () {
    const Once = Rpc.make("once", { success: Schema.Int, stream: true });
    const Ones = RpcGroup.make(Once);

    const ones = Ones.toLayer(
      Ones.of({
        once: (_, request) => feed.subscribe(request, { initial: Effect.as(feed.end(), [1]) }),
      }),
    );

    const collected = yield* Effect.scoped(
      Effect.flatMap(Effect.provide(RpcTest.makeClient(Ones), ones), (rpc) =>
        Stream.runCollect(rpc.once()),
      ),
    );

    return Array.from(collected);
  });

const tick = (rpc: Client, initial: ReadonlyArray<number>, key: string | null = null) =>
  follow(rpc.ticks({ key, initial, read: "at once" }), initial.length);

describe("Feed.layer", () => {
  it.effect("sends a subscriber its initial values, then each value published to its rpc", () =>
    Effect.gen(function* () {
      const feed = yield* Feed.Feed;
      const rpc = yield* client;
      const ticks = yield* tick(rpc, [1, 2]);
      const others = yield* follow(rpc.others({ key: null }), 1);

      yield* feed.publish(Ticks, 3);
      yield* feed.publish(Others, 9);
      yield* feed.publish(Ticks, 4);
      yield* feed.end();

      expect([ticks.first, yield* ticks.rest]).toEqual([
        [1, 2],
        [3, 4],
      ]);
      expect([others.first, yield* others.rest]).toEqual([[0], [9]]);
    }).pipe(Effect.scoped, Effect.provide(served)),
  );

  it.effect(
    "keeps a subscriber before reading its initial values, so a value published meanwhile follows them",
    () =>
      Effect.gen(function* () {
        const feed = yield* Feed.Feed;
        const { reading, released } = yield* Gate;
        const rpc = yield* client;

        const pending = yield* Effect.forkScoped(
          follow(rpc.ticks({ key: null, initial: [10], read: "held" }), 1),
        );

        yield* Deferred.await(reading);
        yield* feed.publish(Ticks, 99);
        yield* Deferred.succeed(released, undefined);

        const subscriber = yield* Fiber.join(pending);

        yield* feed.end();

        expect([subscriber.first, yield* subscriber.rest]).toEqual([[10], [99]]);
      }).pipe(Effect.scoped, Effect.provide(served)),
  );

  it.effect(
    "ends a subscriber's stream through the server, running its finalizers, by rpc and key, then every one with end()",
    () =>
      Effect.gen(function* () {
        const feed = yield* Feed.Feed;
        const { finalized } = yield* Gate;
        const rpc = yield* client;
        const a = yield* tick(rpc, [1], "a");
        const b = yield* tick(rpc, [2], "b");
        const others = yield* follow(rpc.others({ key: null }), 1);

        yield* feed.end(Ticks, { key: "a" });
        yield* Fiber.join(a.fiber);

        const afterOne = yield* Ref.get(finalized);

        yield* feed.publish(Ticks, 5);
        yield* feed.end();

        expect(afterOne).toBe(1);
        expect(yield* a.rest).toEqual([]);
        expect(yield* b.rest).toEqual([5]);
        expect(yield* others.rest).toEqual([]);
        expect(yield* Ref.get(finalized)).toBe(3);
      }).pipe(Effect.scoped, Effect.provide(served)),
  );

  it.effect(
    "ends a subscriber whose initial values are still read, interrupting the read and sending nothing",
    () =>
      Effect.gen(function* () {
        const feed = yield* Feed.Feed;
        const { reading, finalized } = yield* Gate;
        const rpc = yield* client;

        const collected = yield* Effect.forkScoped(
          Stream.runCollect(rpc.ticks({ key: null, initial: [10], read: "held" })),
        );

        yield* Deferred.await(reading);
        yield* feed.end();

        expect(Array.from(yield* Fiber.join(collected))).toEqual([]);
        expect(yield* Ref.get(finalized)).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(served)),
  );

  it.effect(
    "reaches a group's subscribers by the rpc it wraps with its middleware, in what it publishes and ends",
    () =>
      Effect.gen(function* () {
        const feed = yield* Feed.Feed;
        const wrapped = yield* Effect.provide(RpcTest.makeClient(Wrapped), wrappedServed);
        const a = yield* follow(wrapped.watch(), 1);

        yield* feed.publish(WrappedWatch, 1);
        yield* feed.end(WrappedWatch);

        expect([a.first, yield* a.rest]).toEqual([[0], [1]]);
      }).pipe(Effect.scoped, Effect.provide(Feed.layer)),
  );

  it.effect(
    "refuses a second definition of a tag, another group's, at its publish, end and subscribe",
    () =>
      Effect.gen(function* () {
        const feed = yield* Feed.Feed;
        const wrapped = yield* Effect.provide(RpcTest.makeClient(Wrapped), wrappedServed);
        const plain = yield* Effect.provide(RpcTest.makeClient(Plain), plainServed);

        yield* follow(wrapped.watch(), 1);

        const published = yield* Effect.exit(feed.publish(PlainWatch, 2));
        const ended = yield* Effect.exit(feed.end(PlainWatch));
        const subscribed = yield* Effect.exit(Stream.runDrain(plain.watch()));

        yield* feed.end();

        expect(Exit.isFailure(published) ? Cause.squash(published.cause) : undefined).toEqual(
          new Error(
            "Feed.layer serves one definition of each rpc tag, and a second definition of watch reached it, as from two groups each defining one: give each rpc its own tag, or each group its own feed",
          ),
        );
        expect(Exit.isFailure(ended) ? Cause.pretty(ended.cause) : "").toContain(
          "a second definition of watch",
        );
        expect(Exit.isFailure(subscribed) ? Cause.pretty(subscribed.cause) : "").toContain(
          "a second definition of watch",
        );
      }).pipe(Effect.scoped, Effect.provide(Feed.layer)),
  );

  it.effect("refuses a second definition of a tag after every subscriber of the first ended", () =>
    Effect.gen(function* () {
      const feed = yield* Feed.Feed;
      const wrapped = yield* Effect.provide(RpcTest.makeClient(Wrapped), wrappedServed);
      const plain = yield* Effect.provide(RpcTest.makeClient(Plain), plainServed);
      const { rest } = yield* follow(wrapped.watch(), 1);

      yield* feed.end();
      yield* rest;

      const subscribed = yield* Effect.exit(Stream.runDrain(plain.watch()));
      const published = yield* Effect.exit(feed.publish(PlainWatch, 2));

      expect(Exit.isFailure(subscribed) ? Cause.pretty(subscribed.cause) : "").toContain(
        "a second definition of watch",
      );
      expect(Exit.isFailure(published) ? Cause.pretty(published.cause) : "").toContain(
        "a second definition of watch",
      );
    }).pipe(Effect.scoped, Effect.provide(Feed.layer)),
  );

  it.effect(
    "admits one of two definitions of a tag subscribing at once, each yielding inside its subscribe, and publishes to it alone",
    () =>
      Effect.gen(function* () {
        const feed = yield* Feed.Feed;
        const outcomes = yield* Queue.unbounded<typeof WrappedWatch | "refused">();
        const received = yield* Queue.unbounded<number>();
        const reading = yield* Deferred.make<void>();

        const fibers = yield* Effect.forEach(
          [WrappedWatch, PlainWatch],
          (rpc, index) =>
            feed
              .subscribe(
                { rpc, requestId: RpcMessage.RequestId(index) },
                {
                  initial: Queue.offer(outcomes, rpc).pipe(
                    Effect.andThen(Deferred.await(reading)),
                    Effect.as([0]),
                  ),
                },
              )
              .pipe(
                Stream.runForEach((value) => Queue.offer(received, value)),
                Effect.catchCause(() => Queue.offer(outcomes, "refused")),
                Effect.forkScoped,
              ),
          { concurrency: "unbounded" },
        );

        const [first, second] = yield* Queue.takeN(outcomes, 2);
        const admitted = first === "refused" ? second : first;

        yield* Deferred.succeed(reading, undefined);
        yield* Queue.take(received);

        if (admitted !== undefined && admitted !== "refused") yield* feed.publish(admitted, 1);

        yield* feed.end();
        yield* Effect.forEach(fibers, Fiber.join, { discard: true });

        expect([first, second].filter((outcome) => outcome === "refused")).toHaveLength(1);
        expect(yield* Queue.clear(received)).toEqual([1]);
      }).pipe(
        Effect.provideService(References.MaxOpsBeforeYield, 20),
        Effect.scoped,
        Effect.provide(Feed.layer),
      ),
  );

  it.effect("keeps apart two rpcs of their own tags made from one hand-built stream schema", () =>
    Effect.gen(function* () {
      const feed = yield* Feed.Feed;
      const shared = RpcSchema.Stream(Schema.String, Schema.Never);
      const Private = Rpc.make("privateWatch", { success: shared });
      const Public = Rpc.make("publicWatch", { success: shared });
      const Both = RpcGroup.make(Private, Public);

      const rpc = yield* Effect.provide(
        RpcTest.makeClient(Both),
        Both.toLayer({
          privateWatch: (_, request) => feed.subscribe(request),
          publicWatch: (_, request) => feed.subscribe(request, { initial: ["public ready"] }),
        }),
      );

      const watching = yield* Queue.unbounded<string>();

      const fiber = yield* Effect.forkScoped(
        Stream.runForEach(rpc.publicWatch(), (value) => Queue.offer(watching, value)),
      );

      const ready = yield* Queue.take(watching);

      yield* feed.publish(Private, "private secret");
      yield* feed.publish(Public, "public update");
      yield* feed.end();
      yield* Fiber.join(fiber);

      expect([ready, ...(yield* Queue.clear(watching))]).toEqual(["public ready", "public update"]);
    }).pipe(Effect.scoped, Effect.provide(Feed.layer)),
  );

  it.effect("sends nothing to a subscriber ended as its initial values are read", () =>
    Effect.gen(function* () {
      const { finalized } = yield* Gate;
      const rpc = yield* client;

      const collected = yield* Stream.runCollect(
        rpc.ticks({ key: null, initial: [10], read: "ending" }),
      );

      expect(Array.from(collected)).toEqual([]);
      expect(yield* Ref.get(finalized)).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(served)),
  );

  it.effect(
    "ends a subscriber of one rpc by key, leaving another rpc's subscriber of the same key",
    () =>
      Effect.gen(function* () {
        const feed = yield* Feed.Feed;
        const rpc = yield* client;
        const ticks = yield* tick(rpc, [1], "a");
        const others = yield* follow(rpc.others({ key: "a" }), 1);

        yield* feed.end(Ticks, { key: "a" });
        yield* feed.publish(Others, 7, { key: "a" });
        yield* feed.end();

        expect(yield* ticks.rest).toEqual([]);
        expect(yield* others.rest).toEqual([7]);
      }).pipe(Effect.scoped, Effect.provide(served)),
  );

  it.effect("keeps no value published after a subscriber's initial values failed", () =>
    Effect.gen(function* () {
      const feed = yield* Feed.Feed;
      const rpc = yield* Effect.provide(RpcTest.makeClient(Holding), holdingServed);

      yield* Effect.flip(Stream.runDrain(rpc.held({ failing: true })));

      expect(yield* released(yield* publishHeld(feed))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(Feed.layer)),
  );

  it.effect("keeps no value published after a subscriber's client interrupted it", () =>
    Effect.gen(function* () {
      const feed = yield* Feed.Feed;
      const rpc = yield* Effect.provide(RpcTest.makeClient(Holding), holdingServed);
      const received = yield* Queue.unbounded<number>();

      const fiber = yield* Effect.forkScoped(
        Stream.runForEach(rpc.held({ failing: false }), ({ n }) => Queue.offer(received, n)),
      );

      yield* Queue.take(received);
      yield* Fiber.interrupt(fiber);

      expect(yield* released(yield* publishHeld(feed))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(Feed.layer)),
  );

  it.effect("sends nothing to a subscriber end reached as its initial values were read", () =>
    Effect.gen(function* () {
      expect(yield* endedAsRead(yield* Feed.Feed)).toEqual([]);
    }).pipe(Effect.provide(Feed.layer)),
  );

  it.effect("keeps a value published to a live subscriber until it is read", () =>
    Effect.gen(function* () {
      const feed = yield* Feed.Feed;
      const rpc = yield* Effect.provide(RpcTest.makeClient(Holding), holdingServed);
      const opened = yield* Deferred.make<void>();
      const reading = yield* Deferred.make<void>();

      yield* Effect.forkScoped(
        Stream.runForEach(rpc.held({ failing: false }), () =>
          Deferred.succeed(opened, undefined).pipe(Effect.andThen(Deferred.await(reading))),
        ),
      );

      yield* Deferred.await(opened);

      expect(yield* released(yield* publishHeld(feed))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(Feed.layer)),
  );

  it.effect("fails a subscriber whose initial values fail, and sends it nothing more", () =>
    Effect.gen(function* () {
      const feed = yield* Feed.Feed;
      const rpc = yield* client;

      const failed = yield* Effect.flip(
        Stream.runCollect(rpc.ticks({ key: null, initial: [], read: "failing" })),
      );

      const kept = yield* tick(rpc, [1]);

      yield* feed.publish(Ticks, 2);
      yield* feed.end();

      expect(failed).toBeInstanceOf(NoInitial);
      expect(yield* kept.rest).toEqual([2]);
    }).pipe(Effect.scoped, Effect.provide(served)),
  );
});

const Value = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 }));

const Key = Schema.NullOr(Schema.Literals(["a", "b"]));

it.effect.prop(
  "sends every subscriber its initial values, then each value published to its key or to none from when it joined, in order",
  {
    published: Schema.Array(Schema.Struct({ value: Value, key: Key })).check(
      Schema.isBetweenLength(0, 8),
    ),
    subscribers: Schema.Array(
      Schema.Struct({
        initial: Schema.NonEmptyArray(Value),
        key: Key,
        at: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 })),
      }),
    ).check(Schema.isBetweenLength(1, 4)),
  },
  ({ published, subscribers }) =>
    Effect.gen(function* () {
      const feed = yield* Feed.Feed;
      const rpc = yield* client;

      const joined: Array<{
        readonly expected: ReadonlyArray<number>;
        readonly received: Effect.Effect<ReadonlyArray<number>, NoInitial>;
      }> = [];

      for (let index = 0; index <= published.length; index++) {
        for (const { initial, key, at } of subscribers) {
          if (Math.min(at, published.length) !== index) continue;

          const { first, rest } = yield* tick(rpc, initial, key);

          joined.push({
            expected: [
              ...initial,
              ...published
                .slice(index)
                .filter((value) => value.key === null || value.key === key)
                .map(({ value }) => value),
            ],
            received: Effect.map(rest, (values) => [...first, ...values]),
          });
        }

        const next = published[index];

        if (next !== undefined)
          yield* feed.publish(Ticks, next.value, { key: next.key ?? undefined });
      }

      yield* feed.end();

      for (const { expected, received } of joined) expect(yield* received).toEqual(expected);
    }).pipe(Effect.scoped, Effect.provide(served)),
);
