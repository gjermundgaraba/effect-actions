import { describe, expect, it } from "@effect/vitest";
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Schema, Tracer } from "effect";
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

const holdingFirst = Effect.gen(function* () {
  const entered = yield* Deferred.make<void>();
  const again = yield* Deferred.make<void>();
  const gate = yield* Deferred.make<void>();
  const waiting = Deferred.makeUnsafe<void>();
  let posted = 0;

  const client = yield* Action.client(
    Action.implement(Post, () =>
      Effect.gen(function* () {
        const run = ++posted;

        yield* Deferred.succeed(run === 1 ? entered : again, undefined);
        yield* Deferred.await(gate);

        return { id: run };
      }),
    ),
  );

  const first = yield* Effect.forkChild(client.post({ text: "hi", request: "r1" }));

  yield* Deferred.await(entered);

  return {
    posted: () => posted,
    repeat: (input: typeof Post.input.Type) =>
      Effect.forkChild(client.post(input)).pipe(
        Effect.provideService(
          Tracer.Tracer,
          Tracer.make({
            span(options) {
              if (options.name === "Idempotency.wait") Deferred.doneUnsafe(waiting, Exit.void);

              return Tracer.nativeTracer.span(options);
            },
          }),
        ),
      ),
    release: Effect.gen(function* () {
      const came = yield* Effect.raceFirst(
        Effect.as(Deferred.await(waiting), "waited" as const),
        Effect.as(Deferred.await(again), "ran again" as const),
      );

      yield* Deferred.succeed(gate, undefined);

      return [came, yield* Fiber.join(first)] as const;
    }),
  };
});

describe("an action's idempotencyKey", () => {
  it.effect(
    "runs two calls given one key at once once, the second waiting for the first and answered as it",
    () =>
      Effect.gen(function* () {
        const held = yield* holdingFirst;
        const second = yield* held.repeat({ text: "hi", request: "r1" });

        expect(yield* held.release).toEqual(["waited", { id: 1 }]);
        expect(yield* Fiber.join(second)).toEqual({ id: 1 });
        expect(held.posted()).toBe(1);
      }).pipe(Effect.provide(Action.layerIdempotency)),
  );

  it.effect(
    "refuses a repeat sent with another input as the first runs, once the first has answered",
    () =>
      Effect.gen(function* () {
        const held = yield* holdingFirst;
        const other = yield* held.repeat({ text: "bye", request: "r1" });

        expect(yield* held.release).toEqual(["waited", { id: 1 }]);
        expect(yield* Effect.flip(Fiber.join(other))).toBeInstanceOf(Action.InvalidInput);
        expect(held.posted()).toBe(1);
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

  it.effect(
    "runs a call again whose declared failure has a status a recovering server sends, and keeps the next declared failure",
    () =>
      Effect.gen(function* () {
        class Busy extends Schema.TaggedError<Busy>()("Busy", {}, { httpApiStatus: 503 }) {}

        class Taken extends Schema.TaggedError<Taken>()("Taken", {}) {}

        const Claim = Action.make("claim", {
          description: "Claim a name, once for each request.",
          input: { request: Schema.String },
          error: [Busy, Taken],
          readOnly: false,
          caller: Action.Anyone,
          idempotencyKey: "request",
        });

        let runs = 0;

        const client = yield* Action.client(
          Action.implement(Claim, () =>
            Effect.suspend(() => Effect.fail((runs += 1) === 1 ? new Busy() : new Taken())),
          ),
        );

        const answers = yield* Effect.forEach([1, 2, 3], () =>
          Effect.flip(client.claim({ request: "r1" })),
        );

        expect(answers).toEqual([new Busy(), new Taken(), new Taken()]);
        expect(runs).toBe(2);
      }).pipe(Effect.provide(Action.layerIdempotency)),
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

  it.effect(
    "dies naming the missing service where the types did not require Action.Idempotency",
    () =>
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

        expect(Exit.isFailure(exit) && String(Cause.squash(exit.cause))).toContain(
          "Service not found: effect-actions/Action/Idempotency",
        );
      }),
  );
});
