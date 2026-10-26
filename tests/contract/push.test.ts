import { describe, expect, it } from "@effect/vitest";
import { DateTime, Deferred, Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { AnyOccurrence, Checked } from "../../src/contract/occurrence.js";
import { type Pushed, pushed } from "../../src/contract/push.js";

const positionOf = (sent: Pushed) =>
  sent._tag === "Failed" ? "failed" : `${sent._tag} ${sent.cursor ?? "null"}`;

describe("pushed", () => {
  it.effect("sends in a heartbeat only a position whose occurrences were delivered", () =>
    Effect.gen(function* () {
      const occurrence = AnyOccurrence.make({
        eventId: "c1",
        name: "counter.counted",
        timestamp: DateTime.makeUnsafe(0),
        data: { n: 1 },
        cursor: "1",
      });

      const open = (cursor: string | null) =>
        cursor === "0"
          ? Stream.concat(Stream.make(occurrence, Checked.make({ cursor: "1" })), Stream.never)
          : Stream.never;

      const delivering = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      const sent: Array<string> = [];

      const pushing = yield* pushed(open, "0", (each) =>
        Effect.andThen(
          each._tag === "Occurrence"
            ? Effect.andThen(Deferred.succeed(delivering, undefined), Deferred.await(delivered))
            : Effect.void,
          Effect.sync(() => sent.push(positionOf(each))),
        ),
      ).pipe(Effect.forkChild);

      yield* Deferred.await(delivering);
      yield* TestClock.adjust("30 seconds");

      const whileDelivering = [...sent];

      yield* Deferred.succeed(delivered, undefined);
      yield* TestClock.adjust("30 seconds");
      yield* Fiber.interrupt(pushing);

      expect([whileDelivering, sent]).toEqual([
        ["Checked 0", "Checked 0"],
        ["Checked 0", "Checked 0", "Occurrence 1", "Checked 1"],
      ]);
    }),
  );
});
