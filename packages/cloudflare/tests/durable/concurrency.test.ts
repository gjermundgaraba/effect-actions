import { describe, expect, it } from "@effect/vitest";
import { env } from "cloudflare:workers";
import { Effect, Fiber } from "effect";

import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";
import { latch } from "../support/latch.js";
import { RacedRpcs } from "../support/raced.js";

const calls = 20;

const rounds = 5;

const bumpedAtOnce = (stubOf: (round: number) => ActionDurableObject.Stub) =>
  Effect.gen(function* () {
    const host = yield* ActionDurableObject.client(RacedRpcs);

    return yield* Effect.forEach(
      Array.from({ length: rounds }, (_, round) => round),
      (round) =>
        Effect.gen(function* () {
          const raced = host(() => stubOf(round));

          yield* Effect.forEach(
            Array.from({ length: calls }),
            () => raced.bump(),
            {
              concurrency: "unbounded",
              discard: true,
            }
          );

          return yield* raced.count();
        })
    );
  }).pipe(Effect.scoped);

describe("an object's Effects", () => {
  it.effect(
    "yield to one another before a timer set first, over the stub and through run",
    () =>
      Effect.gen(function* () {
        const stub = env.RACED.getByName("yielding");

        const raced = (yield* ActionDurableObject.client(RacedRpcs))(
          () => stub
        );

        expect(yield* raced.yieldsPastTimer()).toBe(false);
        expect(
          yield* Effect.promise(async () => await stub.yieldsPastTimer())
        ).toBe(false);
      }).pipe(Effect.scoped)
  );
});

describe("a call arriving while a failed build is built again", () => {
  it.effect(
    "is answered when it calls the object back, outside the build's gate",
    () =>
      Effect.gen(function* () {
        const stub = env.BUILT_AGAIN_RACED.getByName("called-back");

        const raced = (yield* ActionDurableObject.client(RacedRpcs))(
          () => stub
        );

        expect(yield* raced.callsBack()).toBe(404);
      }).pipe(Effect.scoped)
  );
});

describe("calls in flight on one object, each reading then writing storage", () => {
  it.effect(
    "lose no write to one another arriving while a failed build is built again",
    () =>
      Effect.map(
        bumpedAtOnce((round) =>
          env.BUILT_AGAIN_RACED.getByName(`built-again-${round}`)
        ),
        (counts) => {
          expect(counts).toStrictEqual(
            Array.from({ length: rounds }, () => calls)
          );
        }
      )
  );

  it.live(
    "wait behind the runtime's gate while the instance builds, then lose no write",
    () =>
      Effect.gen(function* () {
        const stub = env.LATCHED_RACED.getByName("held");

        const raced = (yield* ActionDurableObject.client(RacedRpcs))(
          () => stub
        );

        const bumps = yield* Effect.forkChild(
          Effect.all([raced.bump(), raced.bump()], { concurrency: "unbounded" })
        );

        yield* Effect.promise(async () => {
          await latch.entered;
        });
        yield* Effect.sleep("50 millis");
        expect(bumps.pollUnsafe()).toBeUndefined();

        latch.release();
        yield* Fiber.join(bumps);

        expect(yield* raced.count()).toBe(2);
      }).pipe(Effect.scoped)
  );
});
