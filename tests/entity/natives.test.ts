import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Exit, Fiber, Layer, Schema } from "effect";
import { Entity, ShardingConfig, TestRunner } from "effect/cluster";
import { Rpc, RpcClient, RpcGroup } from "effect/rpc";

import * as Action from "../../src/contract/Action.js";
import * as ActionEntity from "../../src/entity/ActionEntity.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import { CurrentActor } from "../support/app/authorization.js";
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
  payload: { id: Schema.String, uninterruptible: Schema.Boolean },
});

const Natives = RpcGroup.make(Bump, Inspect, Hold, Count, Mark);

const Peek = Action.make("peek", {
  description: "Read the counter's tally.",
  input: { counter: Schema.String },
  success: { count: Schema.Int, by: Schema.String },
  readOnly: true,
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

const marked: string[] = [];

const services = Layer.sync(Tally)(() => {
  builds.services += 1;

  return { count: 0 };
});

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
      hold: () => Rpc.fork(Effect.sleep("3 seconds")),
      count: () => Effect.map(Tally, ({ count }) => count),
      mark: ({ payload: { id, uninterruptible } }) => {
        const work = Effect.andThen(
          Effect.sleep("400 millis"),
          Effect.sync(() => {
            marked.push(id);
          })
        );

        return uninterruptible ? Rpc.uninterruptible(work) : work;
      },
    }) satisfies Entity.HandlersFrom<RpcGroup.Rpcs<typeof Natives>>
);

const peek = Action.implement(
  Peek,
  Effect.map(
    Tally,
    (tally) => () =>
      Effect.map(CurrentActor, ({ id }) => ({ count: tally.count, by: id }))
  ),
  { authorize: Action.allowAll }
);

const counters = ActionEntity.layer(Counter, peek, { services, rpcs }).pipe(
  Layer.provideMerge(TestRunner.layer),
  Layer.provide(signIn)
);

const signedIn = RpcClient.withHeaders({ authorization: "Bearer alice" });

describe("ActionEntity's native rpcs and services", () => {
  it.live(
    "builds services per entity id, shared by its native rpcs' handlers and its implementations, the natives authenticating nothing",
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

        yield* Effect.forkChild(natives("f").hold());
        yield* Effect.sleep("50 millis");

        expect(
          yield* natives("f").bump().pipe(Effect.timeout("1 second"))
        ).toBe(1);
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

        const interrupted = (id: string, uninterruptible: boolean) =>
          Effect.gen(function* () {
            const call = yield* Effect.forkChild(
              natives(id).mark({ id, uninterruptible })
            );

            yield* Effect.sleep("150 millis");
            yield* Fiber.interrupt(call);
            yield* Effect.sleep("600 millis");

            return marked.filter((mark) => mark === id);
          });

        expect(yield* interrupted("kept", true)).toStrictEqual(["kept"]);
        expect(yield* interrupted("stopped", false)).toStrictEqual([]);
      }).pipe(Effect.scoped, Effect.provide(counters))
  );

  it("refuses a native rpc named after an action as the entity is made", () => {
    expect(() =>
      ActionEntity.make(
        "Clash",
        ActionRpc.make([Peek], { authentication: Login }),
        {
          key: { peek: ({ counter }) => counter },
          rpcs: RpcGroup.make(Rpc.make("peek")),
        }
      )
    ).toThrow("are named after an action, an event type or an event's release");
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
