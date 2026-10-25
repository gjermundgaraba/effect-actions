import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { layerIdempotency } from "../../src/durable/idempotency.js";

const Post = Action.make("post", {
  description: "Post a message, once for each request.",
  input: { text: Schema.String, request: Schema.optional(Schema.String) },
  success: { id: Schema.Int },
  readOnly: false,
  caller: Action.Anyone,
  idempotencyKey: "request",
});

const day = 24 * 60 * 60 * 1000;

let objects = 0;

const posted = { count: 0 };

const posting = Action.implement(Post, () => Effect.sync(() => ({ id: ++posted.count })));

const inNewInstance = <A>(
  name: string,
  at: number,
  use: (
    client: Action.Client<typeof posting>,
    state: DurableObjectState,
  ) => Effect.Effect<A, unknown>,
) =>
  Effect.promise(() =>
    runInDurableObject(env.ROUTER_PROVIDED.getByName(name), (_, state) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(at);

          return yield* use(yield* Action.client(posting), state);
        }).pipe(
          Effect.scoped,
          Effect.provide(layerIdempotency(state)),
          Effect.provide(TestClock.layer()),
        ),
      ),
    ),
  );

const keptKeys = (state: DurableObjectState) =>
  Effect.promise(async () => [
    ...(await state.storage.list({ prefix: "effect-actions/idempotency/" })).keys(),
  ]);

describe("an object's kept answers", () => {
  it.effect("answer a repeat in the object's next instance, from its storage", () =>
    Effect.gen(function* () {
      const name = `idempotency-${objects++}`;
      const start = Date.now();
      const before = posted.count;

      const first = yield* inNewInstance(name, start, (client) =>
        client.post({ text: "hi", request: "r1" }),
      );

      const repeat = yield* inNewInstance(name, start + 1000, (client) =>
        client.post({ text: "hi", request: "r1" }),
      );

      expect(repeat).toEqual(first);
      expect(posted.count - before).toBe(1);
    }),
  );

  it.effect("are deleted a day on, as a later answer is kept", () =>
    Effect.gen(function* () {
      const name = `idempotency-${objects++}`;
      const start = Date.now();

      const kept = (when: number, request: string) =>
        inNewInstance(name, when, (client, state) =>
          Effect.andThen(client.post({ text: "hi", request }), keptKeys(state)),
        );

      const first = yield* kept(start, "early");
      const both = yield* kept(start + day - 1, "late");
      const pruned = yield* kept(start + day + 1, "later");

      expect([first.length, both.length, pruned.length]).toEqual([1, 2, 2]);
    }),
  );

  it.effect("are deleted at most once an hour, so a write within the hour leaves one expired", () =>
    Effect.gen(function* () {
      const minute = 60 * 1000;

      const counts = yield* inNewInstance(`idempotency-${objects++}`, Date.now(), (client, state) =>
        Effect.gen(function* () {
          const keptAt = (request: string) =>
            Effect.andThen(client.post({ text: "hi", request }), keptKeys(state));

          const first = yield* keptAt("a");

          yield* TestClock.adjust(day - 30 * minute);

          const beforeExpiry = yield* keptAt("b");

          yield* TestClock.adjust(31 * minute);

          const withinTheHour = yield* keptAt("c");

          yield* TestClock.adjust(30 * minute);

          const pastTheHour = yield* keptAt("d");

          return [first, beforeExpiry, withinTheHour, pastTheHour].map(({ length }) => length);
        }),
      );

      expect(counts).toEqual([1, 2, 3, 3]);
    }),
  );

  it.effect(
    "runs two calls given one key at once once, reading the store after the first claims it",
    () =>
      Effect.gen(function* () {
        const ran = yield* Effect.promise(() =>
          runInDurableObject(
            env.ROUTER_PROVIDED.getByName(`idempotency-${objects++}`),
            (_, state) =>
              Effect.runPromise(
                Effect.gen(function* () {
                  const gate = yield* Deferred.make<void>();
                  let runs = 0;

                  const client = yield* Action.client(
                    Action.implement(Post, () =>
                      Effect.gen(function* () {
                        runs += 1;
                        yield* Deferred.await(gate);

                        return { id: runs };
                      }),
                    ),
                  );

                  const both = yield* Effect.forkChild(
                    Effect.all(
                      [
                        client.post({ text: "hi", request: "r1" }),
                        client.post({ text: "hi", request: "r1" }),
                      ],
                      {
                        concurrency: "unbounded",
                      },
                    ),
                  );

                  yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
                  yield* Deferred.succeed(gate, undefined);

                  return { answers: yield* Fiber.join(both), runs };
                }).pipe(Effect.scoped, Effect.provide(layerIdempotency(state))),
              ),
          ),
        );

        expect(ran).toEqual({ answers: [{ id: 1 }, { id: 1 }], runs: 1 });
      }),
  );
});
