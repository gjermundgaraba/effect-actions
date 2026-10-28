import { env } from "cloudflare:workers";
import { Effect, Layer, Schema } from "effect";
import { Rpc, RpcGroup, RpcServer } from "effect/rpc";

import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";

export const RacedRpcs = RpcGroup.make(
  Rpc.make("bump"),
  Rpc.make("count", { success: Schema.Finite }),
  Rpc.make("yieldsPastTimer", { success: Schema.Boolean }),
  Rpc.make("callsBack", { success: Schema.Finite })
);

export const yieldsPastTimer = Effect.suspend(() => {
  let fired = false;

  setTimeout(() => {
    fired = true;
  }, 0);

  return Effect.map(Effect.yieldNow, () => fired);
});

export const builtOnSecondTry = Layer.effectDiscard(
  Effect.flatMap(ActionDurableObject.State, ({ storage }) =>
    Effect.flatMap(
      Effect.promise(async () => {
        const attempts = (await storage.get<number>("attempts")) ?? 0;

        await storage.put("attempts", attempts + 1);

        return attempts;
      }),
      (attempts) =>
        attempts === 0
          ? Effect.die(new Error("The first build fails"))
          : Effect.sleep("30 millis")
    )
  )
);

export const racedCalls = RpcServer.layer(RacedRpcs).pipe(
  Layer.provide(
    RacedRpcs.toLayer({
      bump: () =>
        Effect.flatMap(ActionDurableObject.State, ({ storage }) =>
          Effect.promise(async () => {
            const count = await storage.get<number>("count");

            await storage.put("count", (count ?? 0) + 1);
          })
        ),
      yieldsPastTimer: () => yieldsPastTimer,
      callsBack: (): Effect.Effect<number, never, ActionDurableObject.State> =>
        Effect.flatMap(ActionDurableObject.State, ({ id }) =>
          Effect.promise(async () => {
            const response =
              await env.BUILT_AGAIN_RACED.get(id).fetch("https://object/");

            return response.status;
          })
        ),
      count: () =>
        Effect.flatMap(ActionDurableObject.State, ({ storage }) =>
          Effect.promise(async () => (await storage.get<number>("count")) ?? 0)
        ),
    })
  )
);
