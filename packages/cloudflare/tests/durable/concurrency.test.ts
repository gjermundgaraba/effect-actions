import { env } from "cloudflare:test";
import { Effect } from "effect";
import { describe, expect, it } from "@effect/vitest";
import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";
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

          yield* Effect.forEach(Array.from({ length: calls }), () => raced.bump(), {
            concurrency: "unbounded",
            discard: true,
          });

          return yield* raced.count();
        }),
    );
  }).pipe(Effect.scoped);

describe("an object's Effects", () => {
  it.effect("yield to one another before a timer set first, over the stub and through run", () =>
    Effect.gen(function* () {
      const stub = env.RACED.getByName("yielding");
      const raced = (yield* ActionDurableObject.client(RacedRpcs))(() => stub);

      expect(yield* raced.yieldsPastTimer()).toBe(false);
      expect(yield* Effect.promise(() => stub.yieldsPastTimer())).toBe(false);
    }).pipe(Effect.scoped),
  );
});

describe("a call arriving while a failed build is built again", () => {
  it.effect("is answered when it calls the object back, outside the build's gate", () =>
    Effect.gen(function* () {
      const stub = env.BUILT_AGAIN_RACED.getByName("called-back");
      const raced = (yield* ActionDurableObject.client(RacedRpcs))(() => stub);

      expect(yield* raced.callsBack()).toBe(404);
    }).pipe(Effect.scoped),
  );
});

describe("calls in flight on one object, each reading then writing storage", () => {
  it.effect("lose no write to one another arriving while a failed build is built again", () =>
    Effect.map(
      bumpedAtOnce((round) => env.BUILT_AGAIN_RACED.getByName(`built-again-${round}`)),
      (counts) => {
        expect(counts).toEqual(Array.from({ length: rounds }, () => calls));
      },
    ),
  );

  it.effect("lose no write to one another arriving while the instance builds", () =>
    Effect.map(
      bumpedAtOnce((round) => env.SLOWLY_BUILT_RACED.getByName(`building-${round}`)),
      (counts) => {
        expect(counts).toEqual(Array.from({ length: rounds }, () => calls));
      },
    ),
  );
});
