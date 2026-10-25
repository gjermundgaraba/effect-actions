import { describe, expect, it } from "@effect/vitest";
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import * as Action from "../../src/contract/Action.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as Testing from "../../src/testing/Testing.js";

class Member extends Context.Service<Member, string>()("tests/idempotency/Member") {}

const Post = Action.make("post", {
  description: "Post a message, once for each request.",
  input: { text: Schema.String, request: Schema.optional(Schema.String) },
  success: { id: Schema.Int },
  readOnly: false,
  caller: Action.Anyone,
  idempotencyKey: "request",
});

const posting = () => {
  let posted = 0;

  return {
    posted: () => posted,
    implementation: Action.implement(Post, () => Effect.sync(() => ({ id: ++posted }))),
  };
};

describe("an action's idempotencyKey", () => {
  it.live("runs two calls given one key at once once, the second answered as the first", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      let posted = 0;

      const client = yield* Action.client(
        Action.implement(Post, () =>
          Effect.gen(function* () {
            posted += 1;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(gate);

            return { id: posted };
          }),
        ),
      );

      const first = yield* Effect.forkChild(client.post({ text: "hi", request: "r1" }));

      yield* Deferred.await(entered);

      const second = yield* Effect.forkChild(client.post({ text: "hi", request: "r1" }));

      yield* Effect.sleep("100 millis");
      yield* Deferred.succeed(gate, undefined);

      expect([yield* Fiber.join(first), yield* Fiber.join(second)]).toEqual([{ id: 1 }, { id: 1 }]);
      expect(posted).toBe(1);
    }).pipe(Effect.provide(Action.layerIdempotency)),
  );

  it.live(
    "refuses a repeat sent with another input as the first runs, once the first has answered",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        let posted = 0;

        const client = yield* Action.client(
          Action.implement(Post, () =>
            Effect.gen(function* () {
              posted += 1;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(gate);

              return { id: posted };
            }),
          ),
        );

        const first = yield* Effect.forkChild(client.post({ text: "hi", request: "r1" }));

        yield* Deferred.await(entered);

        const other = yield* Effect.forkChild(
          Effect.flip(client.post({ text: "bye", request: "r1" })),
        );

        yield* Effect.sleep("100 millis");
        yield* Deferred.succeed(gate, undefined);

        expect(yield* Fiber.join(first)).toEqual({ id: 1 });
        expect(yield* Fiber.join(other)).toBeInstanceOf(Action.InvalidInput);
        expect(posted).toBe(1);
      }).pipe(Effect.provide(Action.layerIdempotency)),
  );

  it.effect("runs a call again whose first run was interrupted, keeping nothing of it", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let runs = 0;

      const client = yield* Action.client(
        Action.implement(Post, () =>
          Effect.gen(function* () {
            runs += 1;

            if (runs === 1) {
              yield* Deferred.succeed(started, undefined);
              yield* Effect.never;
            }

            return { id: runs };
          }),
        ),
      );

      const cut = yield* Effect.forkChild(client.post({ text: "hi", request: "r1" }));

      yield* Deferred.await(started);
      yield* Fiber.interrupt(cut);

      expect(yield* client.post({ text: "hi", request: "r1" })).toEqual({ id: 2 });
      expect(runs).toBe(2);
    }).pipe(Effect.provide(Action.layerIdempotency)),
  );

  it.effect(
    "runs a call again whose kept answer, of the same input, no longer decodes, as after a deployment changed its success, keeping its new answer",
    () =>
      Effect.gen(function* () {
        const { posted, implementation } = posting();
        const kept = new Map<string, typeof Action.Idempotency.Kept.Type>();

        const store = Layer.succeed(Action.Idempotency)(
          Action.Idempotency.of({
            get: (id) => Effect.sync(() => kept.get(id)),
            set: (id, answer) => Effect.sync(() => void kept.set(id, answer)),
          }),
        );

        const answers = yield* Effect.gen(function* () {
          const client = yield* Action.client(implementation);

          const first = yield* client.post({ text: "hi", request: "r1" });

          for (const [id, answer] of kept) kept.set(id, { ...answer, outcome: '{"id":"one"}' });

          return [first, yield* client.post({ text: "hi", request: "r1" })];
        }).pipe(Effect.provide(store));

        expect(answers).toEqual([{ id: 1 }, { id: 2 }]);
        expect(posted()).toBe(2);
        expect([...kept.values()].map(({ outcome }) => outcome)).not.toContain('{"id":"one"}');
      }),
  );

  it.effect("keeps an answer in memory for 24 hours, and forgets it once a later one is kept", () =>
    Effect.gen(function* () {
      const { posted, implementation } = posting();
      const client = yield* Action.client(implementation);

      yield* client.post({ text: "hi", request: "early" });
      yield* TestClock.adjust("24 hours");
      yield* client.post({ text: "hi", request: "early" });

      expect(posted()).toBe(1);

      yield* TestClock.adjust("1 millis");
      yield* client.post({ text: "hi", request: "late" });

      expect(yield* client.post({ text: "hi", request: "early" })).toEqual({ id: 3 });
    }).pipe(Effect.provide(Action.layerIdempotency)),
  );

  it.effect("answers a repeat over HTTP from what the first call kept", () =>
    Effect.gen(function* () {
      const { posted, implementation } = posting();
      const Http = ActionHttp.make([Post]);

      const answers = yield* Effect.gen(function* () {
        const client = yield* ActionHttp.client(Http);

        return [
          yield* client.post({ text: "hi", request: "r1" }),
          yield* client.post({ text: "hi", request: "r1" }),
          yield* client.post({ text: "hi" }),
        ];
      }).pipe(
        Effect.provide(
          Testing.layer(
            ActionHttp.layer(Http, implementation).pipe(Layer.provide(Action.layerIdempotency)),
          ),
        ),
      );

      expect(answers).toEqual([{ id: 1 }, { id: 1 }, { id: 2 }]);
      expect(posted()).toBe(2);
    }),
  );

  it.effect("answers a repeat of an action answering nothing from what the first kept", () =>
    Effect.gen(function* () {
      let runs = 0;

      const Touch = Action.make("touch", {
        description: "Touch a file, once for each request.",
        input: { request: Schema.String },
        readOnly: false,
        caller: Action.Anyone,
        idempotencyKey: "request",
      });

      const client = yield* Action.client(
        Action.implement(Touch, () => Effect.sync(() => void (runs += 1))),
      );

      yield* client.touch({ request: "r1" });
      yield* client.touch({ request: "r1" });

      expect(runs).toBe(1);
    }).pipe(Effect.provide(Action.layerIdempotency)),
  );

  it("is refused at make on an action answering a stream", () => {
    expect(() =>
      Action.make("tail", {
        description: "Tail a log.",
        input: { request: Schema.String },
        success: Action.Stream(Schema.String),
        readOnly: false,
        caller: Action.Anyone,
        idempotencyKey: "request",
      }),
    ).toThrow(
      new Error(
        'Action "tail" answers a stream, so it takes no idempotencyKey (a kept answer is whole: answer a value, or remove the key)',
      ),
    );
  });

  it.effect("dies naming the fix where the types did not require Action.Idempotency", () =>
    Effect.gen(function* () {
      const erased: ReadonlyArray<Action.Any> = [{ ...Post, caller: Member }];

      const exit = yield* Effect.exit(
        Effect.scoped(
          Action.client(
            Action.implement(
              erased,
              { post: () => Effect.never },
              {
                authorize: Action.allowAll,
              },
            ),
          ),
        ),
      );

      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toEqual(
        new Error(
          "An action naming idempotencyKey is served without Action.Idempotency (provide Action.layerIdempotency, or a layer of Action.Idempotency, around the surfaces)",
        ),
      );
    }),
  );
});
