import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { settle } from "../support/events.js";

const Key = Schema.Literals(["a", "b"]);

const Status = Event.make("status.changed", {
  description: "A key's status changed.",
  input: { key: Schema.optional(Key) },
  payload: { value: Schema.Int },
  caller: Action.Anyone,
});

type Key = typeof Key.Type;

const makeStatuses = () => {
  const values = new Map<Key | undefined, number>();

  const implementation = Event.implement(Status, {
    current: ({ key }) => Effect.sync(() => ({ value: values.get(key) ?? 0 })),
    key: ({ key }) => key,
  });

  return { values, implementation };
};

describe("Event current source", () => {
  it.effect(
    "sends a watcher the value first, then after each notify, a value set again included",
    () =>
      Effect.gen(function* () {
        const statuses = makeStatuses();
        const client = yield* Action.client(statuses.implementation);
        const events = yield* Event.Events;

        const watching = yield* client
          .watch(Status, { key: "a" })
          .pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);

        yield* settle;

        for (const value of [1, 0]) {
          statuses.values.set("a", value);
          yield* events.notify(Status, { key: "a" });
          yield* settle;
        }

        const received = yield* Fiber.join(watching);

        expect(received.map((item) => (item._tag === "Gap" ? "gap" : item.data.value))).toEqual([
          0, 1, 0,
        ]);
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("sends a watcher of one key nothing for a notify of the empty key, another key", () =>
    Effect.gen(function* () {
      const statuses = makeStatuses();
      const client = yield* Action.client(statuses.implementation);
      const events = yield* Event.Events;

      const watching = yield* client
        .watch(Status, { key: "a" })
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

      yield* settle;
      yield* events.notify(Status, { key: "" });
      yield* TestClock.adjust("5 seconds");
      statuses.values.set("a", 1);
      yield* events.notify(Status, { key: "a" });

      const received = yield* Fiber.join(watching);

      expect(received.map((item) => (item._tag === "Gap" ? "gap" : item.data.value))).toEqual([
        0, 1,
      ]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("sends a value written while the value was read, at the read its notify wakes", () =>
    Effect.gen(function* () {
      const events = yield* Event.Events;
      let value = 0;

      const racing = Event.implement(Status, {
        current: () =>
          Effect.gen(function* () {
            const read = value;

            if (read === 0) {
              value = 1;
              yield* events.notify(Status);
            }

            return { value: read };
          }),
      });

      const client = yield* Action.client(racing);

      const received = yield* client
        .watch(Status, {})
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

      yield* settle;

      expect(
        (yield* Fiber.join(received)).map((item) =>
          item._tag === "Gap" ? "gap" : item.data.value,
        ),
      ).toEqual([0, 1]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );
});
