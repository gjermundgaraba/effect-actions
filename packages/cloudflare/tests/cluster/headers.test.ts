import { describe, expect, it } from "@effect/vitest";
import * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";
import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { RpcClient } from "effect/rpc";

import { initialize, Seer } from "../worker.js";

const sent = {
  authorization: "Bearer alice",
  "x-trace": "abc123",
  "x-tenant": "acme",
};

describe("ActionEntity.layer's headers on workerd", () => {
  it.live(
    "authenticates a unary and a stream rpc from exactly the headers their client sent",
    () =>
      Effect.gen(function* () {
        const context = yield* Effect.promise(
          async () => await initialize(env)
        );

        const seer = yield* Effect.provideContext(
          ActionEntity.client(Seer),
          context
        );

        const steps: number[] = [];

        const unary = yield* seer
          .readHeaders({ room: "headers" })
          .pipe(RpcClient.withHeaders(sent));

        const streamed = yield* seer
          .streamHeaders(
            { room: "headers" },
            { onProgress: ({ step }) => Effect.sync(() => steps.push(step)) }
          )
          .pipe(RpcClient.withHeaders(sent));

        expect(unary).toStrictEqual({ headers: sent });
        expect(streamed).toStrictEqual({ headers: sent });
        expect(steps).toStrictEqual([1]);
      }),
    { timeout: 30_000 }
  );
});
