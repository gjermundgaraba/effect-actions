import { describe, expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";

import { batches } from "../../src/durable/batches.js";
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

const posting = Action.implement(Post, () =>
  Effect.sync(() => {
    posted.count += 1;

    return { id: posted.count };
  })
);

const inNewInstance = <A, E>(
  name: string,
  at: number,
  use: (
    client: Action.Client<typeof posting>,
    state: DurableObjectState
  ) => Effect.Effect<A, E>
) =>
  Effect.promise(
    async () =>
      await runInDurableObject(
        env.ROUTER_PROVIDED.getByName(name),
        async (_, state) =>
          await Effect.runPromise(
            Effect.gen(function* () {
              yield* TestClock.setTime(at);

              return yield* use(yield* Action.client(posting), state);
            }).pipe(
              Effect.scoped,
              Effect.provide(
                layerIdempotency(state).pipe(
                  Layer.provideMerge(TestClock.layer())
                )
              )
            )
          )
      )
  );

const keptKeys = (state: DurableObjectState) =>
  Effect.promise(async () => {
    const kept = await state.storage.list({
      prefix: "effect-actions/idempotency/",
    });

    return [...kept.keys()];
  });

describe("an object's kept answers", () => {
  it.effect(
    "answer a repeat in the object's next instance, from its storage",
    () =>
      Effect.gen(function* () {
        objects += 1;

        const name = `idempotency-${objects}`;
        const start = Date.now();
        const before = posted.count;

        const first = yield* inNewInstance(name, start, (client) =>
          client.post({ text: "hi", request: "r1" })
        );

        const repeat = yield* inNewInstance(name, start + 1000, (client) =>
          client.post({ text: "hi", request: "r1" })
        );

        expect(repeat).toStrictEqual(first);
        expect(posted.count - before).toBe(1);
      })
  );

  it.effect("are deleted a day on, as a later answer is kept", () =>
    Effect.gen(function* () {
      objects += 1;

      const name = `idempotency-${objects}`;
      const start = Date.now();

      const kept = (when: number, request: string) =>
        inNewInstance(name, when, (client, state) =>
          Effect.andThen(client.post({ text: "hi", request }), keptKeys(state))
        );

      const first = yield* kept(start, "early");
      const both = yield* kept(start + day - 1, "late");
      const pruned = yield* kept(start + day + 1, "later");

      expect([first.length, both.length, pruned.length]).toStrictEqual([
        1, 2, 2,
      ]);
    })
  );

  it.effect(
    "are deleted at most once an hour, so a write within the hour leaves one expired",
    () =>
      Effect.gen(function* () {
        const minute = 60 * 1000;

        objects += 1;

        const counts = yield* inNewInstance(
          `idempotency-${objects}`,
          Date.now(),
          (client, state) => {
            const keptAt = (request: string) =>
              Effect.andThen(
                client.post({ text: "hi", request }),
                keptKeys(state)
              );

            return Effect.gen(function* () {
              const first = yield* keptAt("a");

              yield* TestClock.adjust(day - 30 * minute);

              const beforeExpiry = yield* keptAt("b");

              yield* TestClock.adjust(31 * minute);

              const withinTheHour = yield* keptAt("c");

              yield* TestClock.adjust(30 * minute);

              const pastTheHour = yield* keptAt("d");

              return [first, beforeExpiry, withinTheHour, pastTheHour].map(
                ({ length }) => length
              );
            });
          }
        );

        expect(counts).toStrictEqual([1, 2, 3, 3]);
      })
  );

  it.effect(
    "are deleted past their day however many are kept, page by page",
    () =>
      Effect.gen(function* () {
        const start = Date.now();

        const expired = Array.from(
          { length: 300 },
          (_, index) => `post/expired-${index}`
        );

        objects += 1;

        const kept = yield* inNewInstance(
          `idempotency-${objects}`,
          start + day,
          (client, state) =>
            Effect.gen(function* () {
              yield* Effect.forEach(
                batches(expired),
                (batch) =>
                  Effect.promise(async () => {
                    await state.storage.put(
                      Object.fromEntries(
                        batch.map((id) => [
                          `effect-actions/idempotency/${id}`,
                          { input: "", outcome: "", at: start },
                        ])
                      )
                    );
                  }),
                { discard: true }
              );

              yield* client.post({ text: "hi", request: "fresh" });

              return yield* keptKeys(state);
            })
        );

        expect(kept).toHaveLength(1);
      })
  );
});
