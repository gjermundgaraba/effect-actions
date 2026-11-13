import { describe, expect, it } from "@effect/vitest";
import * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";
import { env, exports } from "cloudflare:workers";
import { Cause, Effect, Exit, Schema } from "effect";
import { RpcClient } from "effect/rpc";

import { initialize, Seer } from "../worker.js";

const crashes = Effect.promise(
  async () => await exports.default.fetch("https://worker.example/received")
).pipe(
  Effect.flatMap((response) =>
    Effect.promise(async () => await response.json())
  ),
  Effect.flatMap(
    Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ tag: Schema.String }))
    )
  ),
  Effect.map((all) => all.filter(({ tag }) => tag === "crash").length),
  Effect.orDie
);

describe("ActionEntity.layer's defects on workerd", () => {
  it.live(
    "end an action that died after its work as Internal server error, never run it again, and build the entity again for its next call",
    () =>
      Effect.gen(function* () {
        const context = yield* Effect.promise(
          async () => await initialize(env)
        );

        const seers = yield* Effect.provideContext(Seer.client, context);

        const actions = yield* Effect.provideContext(
          ActionEntity.client(Seer),
          context
        );

        yield* crashes;

        expect(yield* seers("defects").bump()).toBe(1);

        const exit = yield* Effect.exit(
          actions("defects")
            .crash({ room: "defects" })
            .pipe(RpcClient.withHeaders({ authorization: "Bearer alice" }))
        );

        expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
          "Internal server error"
        );
        expect(yield* crashes).toBe(1);
        expect(yield* seers("defects").bump()).toBe(1);
      }),
    { timeout: 30_000 }
  );
});
