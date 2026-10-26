import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import * as Testing from "../../src/testing/Testing.js";
import { attempt, challenged } from "../../src/webhook/attempt.js";

const posting = {
  url: new URL("https://hooks.example.com/alice"),
  subscriptionId: "sub_alice",
  webhookId: "c1",
  body: "{}",
  keys: [new Uint8Array(32)],
};

const endless = (start: string) =>
  Testing.layer(
    async () =>
      new Response(
        new ReadableStream({
          start: (controller) => controller.enqueue(new TextEncoder().encode(start)),
          pull: async (controller) => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            controller.enqueue(new TextEncoder().encode(" ".repeat(1024)));
          },
        }),
      ),
  );

describe("a delivery attempt", () => {
  it.live("succeeds at a 2xx without reading its body, one that never ends included", () =>
    Effect.gen(function* () {
      let pulled = 0;

      const server = Testing.layer(
        async () =>
          new Response(
            new ReadableStream(
              {
                pull: (controller) => {
                  pulled += 1;
                  controller.enqueue(new TextEncoder().encode(" ".repeat(1024)));
                },
              },
              { highWaterMark: 0 },
            ),
          ),
      );

      yield* attempt(posting, Effect.void).pipe(Effect.provide(server), Effect.timeout("1 second"));

      expect(pulled).toBe(0);
    }),
  );

  it.live("cancels a delivery's unread answer once the attempt ends", () =>
    Effect.gen(function* () {
      const released = yield* Deferred.make<void>();

      const server = Testing.layer(async (request) => {
        request.signal.addEventListener("abort", () => Deferred.doneUnsafe(released, Effect.void));

        return new Response(new ReadableStream({ pull: () => new Promise(() => {}) }));
      });

      yield* attempt(posting, Effect.void).pipe(Effect.provide(server));
      yield* Deferred.await(released).pipe(Effect.timeout("1 second"));
    }),
  );

  it.live(
    "reads a verification's answer as far as 4 KiB, counted in bytes, refusing one longer",
    () =>
      Effect.gen(function* () {
        const multibyte = JSON.stringify({ challenge: "abc", padding: "é".repeat(2500) });

        const answers = yield* Effect.forEach(
          [
            Testing.layer(async () => Response.json({ challenge: "abc" })),
            endless(`{"challenge":"abc"`),
            Testing.layer(async () => new Response(multibyte)),
          ],
          (server) =>
            challenged(posting, Effect.void).pipe(
              Effect.provide(server),
              Effect.timeout("1 second"),
            ),
        );

        expect(new TextEncoder().encode(multibyte).length).toBeGreaterThan(4096);
        expect(multibyte.length).toBeLessThan(4096);
        expect(answers).toEqual(["abc", undefined, undefined]);
      }),
  );

  it.effect("times out at 5 seconds, its address check included", () =>
    Effect.gen(function* () {
      const asked = yield* Deferred.make<void>();

      const attempting = yield* attempt(
        posting,
        Effect.andThen(Deferred.succeed(asked, undefined), Effect.never),
      ).pipe(
        Effect.flip,
        Effect.provide(Testing.layer(async () => new Response(null))),
        Effect.forkChild,
      );

      yield* Deferred.await(asked);
      yield* TestClock.adjust("4999 millis");

      const before = attempting.pollUnsafe();

      yield* TestClock.adjust("1 millis");

      expect(before).toBeUndefined();
      expect(yield* Fiber.join(attempting)).toMatchObject({ category: "timeout", final: false });
    }),
  );
});
