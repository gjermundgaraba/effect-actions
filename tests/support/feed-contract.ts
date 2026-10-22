import { Cause, Context, Deferred, Effect, Exit, Layer, Match, Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
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
