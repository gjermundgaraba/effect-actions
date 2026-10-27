import { describe, expect, it } from "@effect/vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Cause, Effect, Exit } from "effect";

import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";
import type { FromEnv } from "../worker.js";

const nameOf = (stub: DurableObjectStub<FromEnv>) =>
  Effect.promise(
    async () =>
      await runInDurableObject(
        stub,
        async (instance) =>
          await instance.run(Effect.exit(ActionDurableObject.name))
      )
  );

describe("ActionDurableObject.name", () => {
  it.effect("is the name the Worker reached the object by", () =>
    Effect.gen(function* () {
      const exit = yield* nameOf(env.FROM_ENV.getByName("room-7"));

      expect(exit).toStrictEqual(Exit.succeed("room-7"));
    })
  );

  it.effect(
    "dies for an object reached by an id that carries no name, naming getByName",
    () =>
      Effect.gen(function* () {
        const exit = yield* nameOf(
          env.FROM_ENV.get(env.FROM_ENV.newUniqueId())
        );

        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
        expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
          "was reached by an id that carries none, as from idFromString or newUniqueId: reach it with getByName(name)"
        );
      })
  );
});
