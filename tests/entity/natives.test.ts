import { describe, expect, it } from "@effect/vitest";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect";
import {
  ClusterSchema,
  Entity,
  ShardingConfig,
  TestRunner,
} from "effect/cluster";
import { Rpc, RpcClient, RpcGroup } from "effect/rpc";

import * as Action from "../../src/contract/Action.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionEntity from "../../src/entity/ActionEntity.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import { actors, CurrentActor } from "../support/app/authorization.js";
import { Login } from "../support/app/binding.js";
import { signIn } from "../support/rooms.js";

class Tally extends Context.Service<Tally, { count: number }>()(
  "test/natives/Tally"
) {}

const Bump = Rpc.make("bump", { success: Schema.Int });

const Inspect = Rpc.make("inspect", {
  payload: { note: Schema.String },
  success: Schema.Struct({
    note: Schema.String,
    headers: Schema.Record(Schema.String, Schema.String),
    requestId: Schema.String,
  }),
});

const Hold = Rpc.make("hold");

const Count = Rpc.make("count", { success: Schema.Int });

const Mark = Rpc.make("mark", {
  payload: { uninterruptible: Schema.Boolean },
});

const Natives = RpcGroup.make(Bump, Inspect, Hold, Count, Mark);

const Peek = Action.make("peek", {
  description: "Read the counter's tally.",
  input: { counter: Schema.String },
  success: { count: Schema.Int, by: Schema.String },
  readOnly: true,
  caller: CurrentActor,
});

const Peeked = Event.make("peeked", {
  description: "The counter was read.",
  input: { counter: Schema.String },
  payload: { by: Schema.String },
  caller: CurrentActor,
});

const Counter = ActionEntity.make(
  "Counter",
  ActionRpc.make([Peek], { authentication: Login }),
  {
    key: { peek: ({ counter }) => counter },
    rpcs: Natives,
  }
);

const builds = { services: 0 };

const gates = {
  held: Deferred.makeUnsafe<undefined>(),
  released: Deferred.makeUnsafe<undefined>(),
  marking: Deferred.makeUnsafe<undefined>(),
  marked: Deferred.makeUnsafe<"done" | "interrupted">(),
};

const services = Layer.merge(
  Layer.sync(Tally)(() => {
    builds.services += 1;

    return { count: 0 };
  }),
  Layer.succeed(CurrentActor)(actors.bob)
);

const rpcs = Effect.map(
  Tally,
  (tally) =>
    ({
      bump: () => Effect.sync(() => (tally.count += 1)),
      inspect: ({ payload, headers, requestId }) =>
        Effect.succeed({
          note: payload.note,
          headers: { ...headers },
          requestId: String(requestId),
        }),
      hold: () =>
        Rpc.fork(
          Effect.andThen(
            Deferred.succeed(gates.held, undefined),
            Deferred.await(gates.released)
          )
        ),
      count: () => Effect.map(Tally, ({ count }) => count),
      mark: ({ payload: { uninterruptible } }) => {
        const { marking, marked } = gates;

        const work = Effect.gen(function* () {
          yield* Deferred.succeed(marking, undefined);
          yield* Effect.sleep("400 millis");
          yield* Deferred.succeed(marked, "done");
        }).pipe(
          Effect.onInterrupt(() => Deferred.succeed(marked, "interrupted"))
        );

        return uninterruptible ? Rpc.uninterruptible(work) : work;
      },
    }) satisfies Entity.HandlersFrom<RpcGroup.Rpcs<typeof Natives>>
);

const peek = Action.implement(
  Peek,
  () =>
    Effect.gen(function* () {
      const { count } = yield* Tally;
      const { id } = yield* CurrentActor;

      return { count, by: id };
    }),
  { authorize: Action.allowAll }
);

const counters = ActionEntity.layer(Counter, peek, { services, rpcs }).pipe(
  Layer.provideMerge(TestRunner.layer),
  Layer.provide(signIn)
);

const signedIn = RpcClient.withHeaders({ authorization: "Bearer alice" });

describe("ActionEntity's native rpcs and services", () => {
  it.live(
    "builds services per entity id, shared by its native rpcs' handlers and its actions' handlers per call, under the caller, the natives authenticating nothing",
    () =>
      Effect.gen(function* () {
        builds.services = 0;

        const natives = yield* Counter.client;
        const actions = yield* ActionEntity.client(Counter);

        expect(yield* natives("a").bump()).toBe(1);
        expect(yield* natives("a").bump()).toBe(2);
        expect(yield* natives("b").bump()).toBe(1);

        expect(
          yield* signedIn(actions("a").peek({ counter: "a" }))
        ).toStrictEqual({
          count: 2,
          by: "alice",
        });

        expect(
          yield* signedIn(actions("b").peek({ counter: "b" }))
        ).toStrictEqual({
          count: 1,
          by: "alice",
        });

        expect(builds.services).toBe(2);

        const unsigned = yield* Effect.exit(
          actions("a").peek({ counter: "a" })
        );

        expect(Exit.findErrorOption(unsigned)).toMatchObject({
          _tag: "Some",
          value: { _tag: "Unauthenticated" },
        });
      }).pipe(Effect.scoped, Effect.provide(counters))
  );

  it.live(
    "gives a native handler Effect's own Entity.Request: its payload, the headers its client sent and the envelope's request id",
    () =>
      Effect.gen(function* () {
        const natives = yield* Counter.client;
        const sent = { authorization: "Bearer alice", "x-trace": "abc" };

        const first = yield* natives("i")
          .inspect({ note: "first" })
          .pipe(RpcClient.withHeaders(sent));

        const second = yield* natives("i")
          .inspect({ note: "second" })
          .pipe(RpcClient.withHeaders(sent));

        expect(first.note).toBe("first");
        expect(first.headers).toStrictEqual(sent);
        expect(first.requestId).toMatch(/^\d+$/u);
        expect(second.requestId).not.toBe(first.requestId);
      }).pipe(Effect.scoped, Effect.provide(counters))
  );

  it.live(
    "runs a native handler answering through Rpc.fork beside the entity's other calls",
    () =>
      Effect.gen(function* () {
        const natives = yield* Counter.client;

        gates.held = yield* Deferred.make<undefined>();
        gates.released = yield* Deferred.make<undefined>();

        const holding = yield* Effect.forkChild(natives("f").hold());

        yield* Deferred.await(gates.held);

        expect(
          yield* natives("f").bump().pipe(Effect.timeout("1 second"))
        ).toBe(1);

        yield* Deferred.succeed(gates.released, undefined);
        yield* Fiber.join(holding);
      }).pipe(Effect.scoped, Effect.provide(counters))
  );

  it.live(
    "provides services to a native handler's answer, which reads them per call",
    () =>
      Effect.gen(function* () {
        const natives = yield* Counter.client;

        yield* natives("s").bump();
        yield* natives("s").bump();

        expect(yield* natives("s").count()).toBe(2);
      }).pipe(Effect.scoped, Effect.provide(counters))
  );

  it.live(
    "finishes a native handler answering through Rpc.uninterruptible after its caller is interrupted, where a plain one stops",
    () =>
      Effect.gen(function* () {
        const natives = yield* Counter.client;

        const interrupted = (uninterruptible: boolean) =>
          Effect.gen(function* () {
            gates.marking = yield* Deferred.make<undefined>();
            gates.marked = yield* Deferred.make<"done" | "interrupted">();

            const call = yield* Effect.forkChild(
              natives("m").mark({ uninterruptible })
            );

            yield* Deferred.await(gates.marking);
            yield* Fiber.interrupt(call);

            return yield* Deferred.await(gates.marked);
          });

        expect(yield* interrupted(true)).toBe("done");
        expect(yield* interrupted(false)).toBe("interrupted");
      }).pipe(Effect.scoped, Effect.provide(counters))
  );

  it.each([
    "peek",
    "peeked",
    "peeked/poll",
    "peeked/release",
    "peeked/subscribe",
    "peeked/unsubscribe",
    "effect-actions/wake",
  ])(
    "refuses a native rpc named %s, an rpc of the binding or the entity's wake, as the entity is made",
    (tag) => {
      expect(() =>
        ActionEntity.make(
          "Clash",
          ActionRpc.make([Peek, Peeked], { authentication: Login }),
          {
            key: {
              peek: ({ counter }) => counter,
              peeked: ({ counter }) => counter,
            },
            rpcs: RpcGroup.make(Rpc.make(tag)),
          }
        )
      ).toThrow(
        `are named after an action, an event type, an event's poll, release, subscribe or unsubscribe, or the entity's wake`
      );
    }
  );

  it("keeps its actions', event types' and webhook subscriptions' rpcs volatile and its wake persisted", () => {
    const Peeking = ActionEntity.make(
      "Peeking",
      ActionRpc.make([Peek, Peeked], { authentication: Login }),
      {
        key: {
          peek: ({ counter }) => counter,
          peeked: ({ counter }) => counter,
        },
      }
    );

    const persisted = Object.fromEntries(
      [...Peeking.protocol.requests].map(([tag, rpc]) => [
        tag,
        Context.get(rpc.annotations, ClusterSchema.Persisted),
      ])
    );

    expect(persisted).toStrictEqual({
      peek: false,
      "peeked/poll": false,
      "peeked/release": false,
      "peeked/subscribe": false,
      "peeked/unsubscribe": false,
      "effect-actions/wake": true,
    });
  });

  it.effect("serves its native rpcs to Entity.makeTestClient", () =>
    Effect.gen(function* () {
      const makeClient = yield* Entity.makeTestClient(
        Counter,
        ActionEntity.layer(Counter, peek, { services, rpcs })
      );

      const counter = yield* makeClient("c");

      expect(yield* counter.bump()).toBe(1);
    }).pipe(Effect.scoped, Effect.provide([ShardingConfig.layer(), signIn]))
  );
});
