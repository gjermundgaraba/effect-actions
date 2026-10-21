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
  Schema,
  type Scope,
  Stream,
} from "effect";
import { Rpc, type RpcClient, type RpcClientError, RpcGroup } from "effect/rpc";
import * as Feed from "@gjermundgaraba/effect-actions/Feed";

export class NoInitial extends Schema.TaggedError<NoInitial>()("NoInitial", {}) {}

export const Ticks = Rpc.make("ticks", {
  payload: {
    key: Schema.NullOr(Schema.String),
    initial: Schema.Array(Schema.Int),
    hold: Schema.Boolean,
    fail: Schema.Boolean,
  },
  success: Schema.Int,
  error: NoInitial,
  stream: true,
});

export const Tocks = Rpc.make("tocks", {
  payload: { initial: Schema.Array(Schema.Int) },
  success: Schema.Int,
  stream: true,
});

export const OtherTicks = Ticks.prefix("other.");

export const ForeignTicks = Rpc.make("ticks", { success: Schema.String, stream: true });

export const Streams = RpcGroup.make(Ticks, Tocks, OtherTicks);

const Published = Schema.Literals(["ticks", "tocks", "other.ticks"]);

export const Controls = RpcGroup.make(
  Rpc.make("publish", {
    payload: { to: Published, value: Schema.Int, key: Schema.NullOr(Schema.String) },
  }),
  Rpc.make("end", {
    payload: { to: Schema.NullOr(Published), key: Schema.NullOr(Schema.String) },
  }),
  Rpc.make("publishForeign", { payload: { value: Schema.String }, success: Schema.String }),
  Rpc.make("reading"),
  Rpc.make("release"),
);

export class Gate extends Context.Service<
  Gate,
  { readonly reading: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
>()("tests/feed-contract/Gate") {
  static readonly layer = Layer.effect(Gate)(
    Effect.all({ reading: Deferred.make<void>(), release: Deferred.make<void>() }),
  );
}

const keyOf = (key: string | null) => (key === null ? undefined : { key });

const initialOf = (
  gate: Gate["Service"],
  { initial, hold, fail }: { initial: ReadonlyArray<number>; hold: boolean; fail: boolean },
) => {
  const read = fail ? Effect.fail(new NoInitial()) : Effect.succeed(initial);

  return hold
    ? Deferred.succeed(gate.reading, undefined).pipe(
        Effect.andThen(Deferred.await(gate.release)),
        Effect.andThen(read),
      )
    : read;
};

export const streamHandlers = Streams.toLayer(
  Effect.gen(function* () {
    const feed = yield* Feed.Feed;
    const gate = yield* Gate;

    return Streams.of({
      ticks: (payload, request) =>
        feed.subscribe(request, { initial: initialOf(gate, payload), ...keyOf(payload.key) }),
      "other.ticks": (payload, request) =>
        feed.subscribe(request, { initial: initialOf(gate, payload), ...keyOf(payload.key) }),
      tocks: ({ initial }, request) => feed.subscribe(request, { initial }),
    });
  }),
);

export const controlHandlers = Controls.toLayer(
  Effect.gen(function* () {
    const feed = yield* Feed.Feed;
    const gate = yield* Gate;

    const rpcOf = Match.type<typeof Published.Type>().pipe(
      Match.when("ticks", () => Ticks),
      Match.when("tocks", () => Tocks),
      Match.when("other.ticks", () => OtherTicks),
      Match.exhaustive,
    );

    return Controls.of({
      publish: ({ to, value, key }) => feed.publish(rpcOf(to), value, keyOf(key)),
      end: ({ to, key }) => (to === null ? feed.end() : feed.end(rpcOf(to), keyOf(key))),
      publishForeign: ({ value }) =>
        Effect.map(Effect.exit(feed.publish(ForeignTicks, value)), (exit) =>
          Exit.isSuccess(exit) ? "published" : Cause.pretty(exit.cause),
        ),
      reading: () => Deferred.await(gate.reading),
      release: () => Effect.asVoid(Deferred.succeed(gate.release, undefined)),
    });
  }),
);

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

const leftToEachLayer = [
  "how values are chunked, as memory sends `initial` as one chunk and the durable feed may send it in several: values are read, never chunks",
  "where a value published while `initial` is read arrives, before it, in it or both: that rule is a set",
  "how long a second definition is refused, memory for the layer's life and the durable feed while a subscriber of the first is live in its instance: it is asserted with one live",
  "an operator on `subscribe`'s stream, which sees no value on the durable feed even live, its values going to the socket",
];

export const feedContract = (name: string, serve: Effect.Effect<FeedServer, never, Scope.Scope>) =>
  describe(`${name} keeps the Feed contract`, () => {
    for (const difference of leftToEachLayer) {
      it.skip(`leaves to each layer's own tests ${difference}`);
    }

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

        const { rest } = yield* subscriber.ended;

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
        expect((yield* tocking.ended).rest).toEqual([7]);
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

          expect(endedA.rest).toEqual([1]);
          expect((yield* b.ended).rest).toEqual([2]);
          expect((yield* none.ended).rest).toEqual([2]);
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

        expect((yield* plain.ended).rest).toEqual([1]);
        expect((yield* prefixed.ended).rest).toEqual([2]);
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
          expect((yield* subscriber.ended).rest).toEqual([1]);
        }).pipe(Effect.scoped),
    );
  });
