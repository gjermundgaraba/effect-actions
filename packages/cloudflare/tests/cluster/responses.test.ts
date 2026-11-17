import { describe, expect, it } from "@effect/vitest";
import * as ActionCluster from "@gjermundgaraba/effect-actions-cloudflare/ActionCluster";
import { Cause, Effect, Logger } from "effect";
import { ClusterError } from "effect/cluster";

const answered = (cause: Cause.Cause<unknown>) =>
  Effect.gen(function* () {
    const logged: unknown[] = [];

    const response = yield* ActionCluster.failureResponse(cause).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make(({ logLevel, cause: reported }) => {
            logged.push([logLevel, reported]);
          }),
        ])
      )
    );

    return {
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
      logged,
    };
  });

describe("ActionCluster.failureResponse", () => {
  it.effect(
    "answers a cluster failure 503 with Retry-After, interrupts alone 499, and anything else 500 after logging it",
    () =>
      Effect.gen(function* () {
        const unreached = Cause.fail(
          new ClusterError.PersistenceError({ cause: new Error("down") })
        );

        const died = Cause.die(new Error("boom"));

        expect(yield* answered(unreached)).toStrictEqual({
          status: 503,
          retryAfter: "1",
          logged: [],
        });
        expect(yield* answered(Cause.interrupt())).toStrictEqual({
          status: 499,
          retryAfter: null,
          logged: [],
        });
        expect(yield* answered(died)).toStrictEqual({
          status: 500,
          retryAfter: null,
          logged: [["Error", died]],
        });
        expect(
          (yield* answered(Cause.combine(unreached, Cause.interrupt()))).status
        ).toBe(503);
      })
  );
});
