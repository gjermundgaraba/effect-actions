import { describe, expect, it } from "@effect/vitest";
import { env } from "cloudflare:workers";
import { Cause, Effect, Exit } from "effect";

import { initialize, Keeper } from "../worker.js";

describe("Webhook.layer with persist in an entity's services on workerd", () => {
  it.live(
    "fails each call to the entity at once, its activation dying, where the authentication names a principal and no schema",
    () =>
      Effect.gen(function* () {
        const context = yield* Effect.promise(
          async () => await initialize(env)
        );

        const keepers = yield* Effect.provideContext(Keeper.client, context);

        const polled = Effect.suspend(() => {
          const answer = keepers("unkept")["kept/poll"]?.(
            { input: { room: "unkept" }, cursor: null },
            { headers: { authorization: "Bearer alice" } }
          );

          return answer !== undefined && Effect.isEffect(answer)
            ? answer
            : Effect.die(new Error("no unary rpc kept"));
        }).pipe(Effect.timeout("5 seconds"), Effect.exit);

        const exits = [yield* polled, yield* polled];

        expect(
          exits.map((exit) =>
            Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "answered"
          )
        ).toStrictEqual([
          expect.stringContaining("has no schema"),
          expect.stringContaining("has no schema"),
        ]);
      }),
    { timeout: 60_000 }
  );
});
