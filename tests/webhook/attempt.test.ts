import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { Dns } from "effect/net";
import { TestClock } from "effect/testing";
import * as Testing from "../../src/testing/Testing.js";
import { attempt, challenged } from "../../src/webhook/attempt.js";

const unanswering = (asked: Deferred.Deferred<void>) =>
  Layer.effect(
    Dns.Dns,
    Effect.map(Dns.Dns, (dns) => ({
      ...dns,
      lookup: () => Effect.andThen(Deferred.succeed(asked, undefined), Effect.never),
    })),
  ).pipe(Layer.provide(Dns.layerStatic({ hosts: {} })));

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

const resolving = Dns.layerStatic({ hosts: { "hooks.example.com": ["93.184.216.34"] } });

describe("a delivery attempt", () => {
  it.live("succeeds at a 2xx without reading its body, one that never ends included", () =>
    Effect.gen(function* () {
      const dns = yield* Effect.service(Dns.Dns).pipe(Effect.provide(resolving));

      yield* attempt(posting, dns).pipe(Effect.provide(endless("")), Effect.timeout("1 second"));
    }),
  );

  it.live("cancels a delivery's unread answer once the attempt ends", () =>
    Effect.gen(function* () {
      const dns = yield* Effect.service(Dns.Dns).pipe(Effect.provide(resolving));
      const released = yield* Deferred.make<void>();

      const server = Testing.layer(async (request) => {
        request.signal.addEventListener("abort", () => Deferred.doneUnsafe(released, Effect.void));

        return new Response(new ReadableStream({ pull: () => new Promise(() => {}) }));
      });

      yield* attempt(posting, dns).pipe(Effect.provide(server));
      yield* Deferred.await(released).pipe(Effect.timeout("1 second"));
    }),
  );

  it.live(
    "reads a verification's answer as far as 4 KiB, counted in bytes, refusing one longer",
    () =>
      Effect.gen(function* () {
        const dns = yield* Effect.service(Dns.Dns).pipe(Effect.provide(resolving));

        const multibyte = JSON.stringify({ challenge: "abc", padding: "é".repeat(2500) });

        const answers = yield* Effect.forEach(
          [
            Testing.layer(async () => Response.json({ challenge: "abc" })),
            endless(`{"challenge":"abc"`),
            Testing.layer(async () => new Response(multibyte)),
          ],
          (server) =>
            challenged(posting, dns).pipe(Effect.provide(server), Effect.timeout("1 second")),
        );

        expect(new TextEncoder().encode(multibyte).length).toBeGreaterThan(4096);
        expect(multibyte.length).toBeLessThan(4096);
        expect(answers).toEqual(["abc", undefined, undefined]);
      }),
  );

  it.effect("times out at 5 seconds, its address check included", () =>
    Effect.gen(function* () {
      const asked = yield* Deferred.make<void>();

      const dns = yield* Effect.service(Dns.Dns).pipe(Effect.provide(unanswering(asked)));

      const attempting = yield* attempt(
        {
          url: new URL("https://hooks.example.com/alice"),
          subscriptionId: "sub_alice",
          webhookId: "c1",
          body: "{}",
          keys: [new Uint8Array(32)],
        },
        dns,
      ).pipe(
        Effect.flip,
        Effect.provide(Testing.layer(async () => new Response(null))),
        Effect.forkChild,
      );

      yield* Deferred.await(asked);
      yield* TestClock.adjust("5 seconds");

      expect(yield* Fiber.join(attempting)).toMatchObject({ category: "timeout", final: false });
    }),
  );
});
