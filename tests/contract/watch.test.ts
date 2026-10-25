import { describe, expect, it } from "@effect/vitest";
import { Clock, Data, DateTime, Effect, Fiber, Logger, Predicate, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import * as Action from "../../src/contract/Action.js";
import * as Event from "../../src/contract/Event.js";
import { type Transport, watching } from "../../src/contract/watch.js";

const Changed = Event.make("user.changed", {
  description: "A user changed.",
  payload: { id: Schema.String },
  caller: Action.Anyone,
});

class Blip extends Data.TaggedError("Blip")<{}> {}

const occurrence = (id: string) => ({
  _tag: "Occurrence" as const,
  eventId: id,
  name: Changed.name,
  timestamp: DateTime.makeUnsafe(0),
  data: { id },
  cursor: id,
});

describe("a watch's reconnects", () => {
  it.effect(
    "wait a second after a failure that follows an occurrence, however many failed before it, then double",
    () =>
      Effect.gen(function* () {
        const opened: Array<number> = [];

        const transport: Transport<Blip, never> = {
          name: Changed.name,
          poll: () => Effect.die("A streamed watch polled"),
          stream: () =>
            Stream.unwrap(
              Effect.map(Clock.currentTimeMillis, (now) => {
                opened.push(now);

                if (opened.length === 3) {
                  return Stream.make(occurrence("u1")).pipe(Stream.concat(Stream.fail(new Blip())));
                }

                return opened.length < 5 ? Stream.fail(new Blip()) : Stream.make(occurrence("u2"));
              }),
            ),
          transient: Predicate.isTagged("Blip"),
        };

        const logged: Array<unknown> = [];

        const watched = yield* watching(transport, { mode: "stream" }).pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.provide(
            Logger.layer([
              Logger.make(({ message }) => {
                logged.push(Array.isArray(message) ? message[0] : message);
              }),
            ]),
          ),
          Effect.forkChild,
        );

        yield* TestClock.adjust("20 seconds");

        const received = yield* Fiber.join(watched);

        expect(received.map((item) => (item._tag === "Gap" ? "gap" : item.eventId))).toEqual([
          "u1",
          "u2",
        ]);
        expect(opened).toEqual([0, 1000, 3000, 4000, 6000]);
        expect(logged).toEqual(
          ["1s", "2s", "1s", "2s"].map((wait) => `A watch reconnects in ${wait} after a failure`),
        );
      }),
  );

  it.effect("wait at most 30 seconds, however many failures in a row", () =>
    Effect.gen(function* () {
      const opened: Array<number> = [];

      const transport: Transport<Blip, never> = {
        name: Changed.name,
        poll: () => Effect.die("A streamed watch polled"),
        stream: () =>
          Stream.unwrap(
            Effect.map(Clock.currentTimeMillis, (now) => {
              opened.push(now);

              return opened.length < 8 ? Stream.fail(new Blip()) : Stream.make(occurrence("u1"));
            }),
          ),
        transient: Predicate.isTagged("Blip"),
      };

      const watched = yield* watching(transport, { mode: "stream" }).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.provide(Logger.layer([])),
        Effect.forkChild,
      );

      yield* TestClock.adjust("2 minutes");
      yield* Fiber.interrupt(watched);

      const waits = opened.slice(1).map((at, index) => at - (opened[index] ?? 0));

      expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    }),
  );
});
