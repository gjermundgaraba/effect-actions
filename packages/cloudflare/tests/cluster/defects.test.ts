import { describe, expect, it } from "@effect/vitest";
import * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";
import { env } from "cloudflare:workers";
import { Cause, Effect, Exit } from "effect";
import { RpcClient } from "effect/rpc";

import { received } from "../support/worker.js";
import { context, Seer } from "../worker.js";

const crashes = Effect.map(
  received,
  (all) => all.filter(({ tag }) => tag === "crash").length
);

describe("ActionEntity.layer's defects on workerd", () => {
  it.live(
    "end an action that died after its work as Internal server error, never run it again, and build the entity again for its next call",
    () =>
      Effect.gen(function* () {
        const built = yield* Effect.promise(async () => await context(env));

        const seers = yield* Effect.provideContext(Seer.client, built);

        const actions = yield* Effect.provideContext(
          ActionEntity.client(Seer),
          built
        );

        yield* crashes;

        expect(yield* seers("defects").bump()).toBe(1);

        const exit = yield* Effect.exit(
          actions
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
