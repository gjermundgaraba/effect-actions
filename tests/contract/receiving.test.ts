import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as Action from "../../src/contract/Action.js";
import * as Event from "../../src/contract/Event.js";
import { webhookFed } from "../../src/contract/receiving.js";

const Changed = Event.make("user.changed", {
  description: "A user changed.",
  payload: { id: Schema.String },
  caller: Action.Anyone,
});

describe("webhookFed", () => {
  it.effect(
    "fails with the reason a terminated envelope's code names, and the refusal for any other",
    () =>
      Effect.gen(function* () {
        const read = webhookFed(Changed);

        const failures = yield* Effect.forEach(
          [
            { code: -32023, message: "Event removed", data: { kind: "event" } },
            { code: -32023, message: "Unsubscribed", data: { kind: "subscription" } },
            { code: -32026, message: "Schema changed", data: { feature: "schema" } },
            { code: -32027, message: "Unreachable", data: { reason: "timeout" } },
            { code: -32024, message: "Revoked.", data: { _tag: "Forbidden", message: "Revoked." } },
            { code: -32000, message: "Ended." },
          ],
          (error) => Effect.flip(read({ type: "terminated", error })),
        );

        expect(failures).toMatchObject([
          { _tag: "SubscriptionError", reason: { _tag: "NotServed" } },
          { _tag: "SubscriptionError", reason: { _tag: "NotSubscribed" } },
          { _tag: "SubscriptionError", reason: { _tag: "Unsupported", feature: "schema" } },
          { _tag: "SubscriptionError", reason: { _tag: "CallbackFailed", category: "timeout" } },
          { _tag: "Forbidden", message: "Revoked." },
          { _tag: "Forbidden", message: "Ended." },
        ]);
      }),
  );
});
