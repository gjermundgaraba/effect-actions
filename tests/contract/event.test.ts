import { describe, expect, it } from "@effect/vitest";
import {
  DateTime,
  Effect,
  ErrorReporter,
  Exit,
  Fiber,
  Latch,
  Logger,
  Match,
  Option,
  Queue,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { KeyValueStore } from "effect/persistence";
import { TestClock } from "effect/testing";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { actors, CurrentActor } from "../support/app/authorization.js";
import {
  makeMessages,
  type Message,
  Posted,
  type Received,
  settle,
  texts,
} from "../support/events.js";
import { recorder } from "../support/reporter.js";

describe("Event.make", () => {
  it("refuses a name that is not lowercase dot-separated segments", () => {
    for (const name of ["Message.posted", "a..b", "", ".a", "a b", "x".repeat(129)]) {
      expect(() =>
        Event.make(name, { description: "", payload: {}, caller: Action.Anyone }),
      ).toThrow(
        `Invalid event name: ${name} (use lowercase dot-separated segments of [a-z0-9_-], at most 128 characters)`,
      );
    }

    expect(
      Event.make("k8s.pod_phase-changed", { description: "", payload: {}, caller: Action.Anyone })
        .name,
    ).toBe("k8s.pod_phase-changed");
  });

  it("holds its schemas for reuse, and is told apart from an action", () => {
    expect(Schema.decodeUnknownSync(Posted.payload)({ id: "1", channel: "a", text: "t" })).toEqual({
      id: "1",
      channel: "a",
      text: "t",
    });
    expect(Event.isEvent(Posted)).toBe(true);
    expect(
      Event.isEvent(
        Action.make("ping", { description: "", readOnly: true, caller: Action.Anyone }),
      ),
    ).toBe(false);
  });
});

describe("Event.implement", () => {
  it.effect("refuses a source holding both check and log, or neither, when its builder runs", () =>
    Effect.gen(function* () {
      const both = Event.implement(
        Posted,
        // @ts-expect-error -- The failure under test: a source holding both, as plain JavaScript could.
        { check: () => Effect.succeed({ events: [], cursor: "0" }), log: {} },
      );

      // @ts-expect-error -- The failure under test: a source holding neither.
      const neither = Event.implement(Posted, {});

      for (const implementation of [both, neither]) {
        const cause = yield* Effect.flip(
          Effect.sandbox(Effect.scoped(Action.client(implementation))),
        );

        expect(String(cause)).toContain(
          'Event "message.posted": its source needs exactly one of check, current or log (give check or current a function, or log its options, {} or { emit: stream })',
        );
      }
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it("requires authorize for a protected event type, and refuses one for a public type", () => {
    const Created = Event.make("note.created", {
      description: "",
      payload: { id: Schema.String },
      caller: CurrentActor,
    });

    const check = () => Effect.succeed({ events: [], cursor: "0" });

    // @ts-expect-error -- The failure under test: a protected event type without authorize.
    expect(() => Event.implement(Created, { check })).toThrow("Protected events require authorize");
    expect(() =>
      // @ts-expect-error -- The failure under test: authorize for a public event type.
      Event.implement(Posted, { check }, { authorize: Event.allowAll }),
    ).toThrow("list a protected event");
  });
});

describe("Action.layer", () => {
  it.effect("builds an event implementation once for every client acquired under it", () =>
    Effect.gen(function* () {
      let built = 0;

      const counted = Event.implement(
        Posted,
        Effect.sync(() => {
          built += 1;

          return { check: makeMessages().check };
        }),
      );

      yield* Effect.gen(function* () {
        yield* Action.client(counted);
        yield* Action.client(counted);
      }).pipe(Effect.provide(Action.layer(counted)));

      expect(built).toBe(1);
    }).pipe(Effect.provide(Event.layerMemory)),
  );
});

describe("Action.client given actions", () => {
  const Ticked = Event.make("clock.ticked", {
    description: "The clock ticked.",
    payload: { n: Schema.Int },
    caller: Action.Anyone,
  });

  const Ping = Action.make("ping", {
    description: "Answers pong.",
    readOnly: true,
    caller: Action.Anyone,
    success: Schema.String,
  });

  const tick = (_input: typeof Ticked.input.Type, cursor: string | null) =>
    Effect.succeed({
      cursor: "1",
      events: cursor === null ? [] : [{ eventId: "t1", data: { n: 1 } }],
    });

  it.effect(
    "watches the event types it lists alone, and builds only the implementations holding what it lists",
    () =>
      Effect.gen(function* () {
        const built: Array<string> = [];

        const clock = Event.implement(
          [Posted, Ticked],
          Effect.sync(() => {
            built.push("clock");

            return {
              "message.posted": { check: makeMessages().check },
              "clock.ticked": { check: tick },
            };
          }),
        );

        const ping = Action.implement(
          [Ping],
          Effect.sync(() => {
            built.push("ping");

            return { ping: () => Effect.succeed("pong") };
          }),
        );

        const watching = yield* Action.client([ping, clock], { actions: [Ticked] });

        const ticks = yield* watching
          .watch(Ticked, {}, { cursor: "0" })
          .pipe(Stream.take(1), Stream.runCollect);

        const unlisted = yield* watching
          // @ts-expect-error -- The failure under test: an event type the client does not list.
          .watch(Posted, {}, { cursor: "0" })
          .pipe(Stream.runCollect, Effect.flip);

        const pinging = yield* Action.client([ping, clock], { actions: [Ping] });

        expect(ticks).toMatchObject([{ _tag: "Occurrence", eventId: "t1", data: { n: 1 } }]);
        expect(unlisted).toMatchObject({ reason: { _tag: "NotServed" } });
        expect(Object.keys(watching)).toEqual(["watch"]);
        expect(Object.keys(pinging)).toEqual(["ping"]);
        expect(yield* pinging.ping()).toBe("pong");
        expect(built).toEqual(["clock", "ping"]);
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it("refuses a listed event type no implementation holds", () => {
    // @ts-expect-error -- The failure under test: an event type no implementation holds.
    expect(() => Action.client([makeMessages().implementation], { actions: [Ticked] })).toThrow(
      "no implementation holds it: clock.ticked",
    );
  });
});

describe("a check source, watched in process", () => {
  it.effect("starts from now, then streams what happened since", () =>
    Effect.gen(function* () {
      const log = makeMessages();
      log.post("general", "before");

      const client = yield* Action.client(log.implementation);
      const events = yield* Event.Events;

      const fiber = yield* client
        .watch(Posted)
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

      yield* settle;
      log.post("general", "one");
      log.post("random", "two");
      yield* events.notify(Posted);

      expect(texts(yield* Fiber.join(fiber))).toEqual(["one", "two"]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("asks the check only when its poll is due", () =>
    Effect.gen(function* () {
      const log = makeMessages();
      let asked = 0;

      const Counted = Event.implement(Posted, {
        check: (input, cursor) => {
          asked += 1;

          return log.check(input, cursor);
        },
      });

      const client = yield* Action.client(Counted);
      const fiber = yield* client.watch(Posted).pipe(Stream.runDrain, Effect.forkChild);

      yield* settle;
      expect(asked).toBe(1);
      yield* TestClock.adjust("4999 millis");
      expect(asked).toBe(1);
      yield* TestClock.adjust("1 millis");
      expect(asked).toBe(2);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("delivers only what the subscription's input selects", () =>
    Effect.gen(function* () {
      const log = makeMessages();
      const client = yield* Action.client(log.implementation);

      const fiber = yield* client
        .watch(Posted, { channel: "random" })
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

      yield* settle;
      log.post("general", "one");
      log.post("random", "two");
      yield* TestClock.adjust("5 seconds");

      expect(texts(yield* Fiber.join(fiber))).toEqual(["two"]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("polls no faster than once a second, and at once while the source has more", () =>
    Effect.gen(function* () {
      let asked = 0;

      const Eager = Event.implement(Posted, {
        check: (_input, cursor) =>
          Effect.sync(() => {
            asked += 1;
            const at = Number(cursor ?? 0);

            return {
              cursor: String(at + 1),
              events: [{ eventId: `e${at}`, data: { id: `e${at}`, channel: "c", text: `${at}` } }],
              hasMore: at < 2,
              nextPoll: "10 millis",
            };
          }),
      });

      const client = yield* Action.client(Eager);

      const fiber = yield* client
        .watch(Posted, {}, { mode: "poll" })
        .pipe(Stream.take(4), Stream.runCollect, Effect.forkChild);

      yield* settle;
      expect(asked).toBe(3);
      yield* TestClock.adjust("999 millis");
      expect(asked).toBe(3);
      yield* TestClock.adjust("1 millis");

      expect(texts(yield* Fiber.join(fiber))).toEqual(["0", "1", "2", "3"]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "arrives as a gap at the fresh cursor where the source says a cursor is stale and has nothing since, streamed and polled",
    () =>
      Effect.gen(function* () {
        const Stale = Event.implement(Posted, {
          check: (_input, cursor) =>
            Effect.succeed(
              cursor === "old"
                ? { cursor: "fresh", truncated: true, events: [] }
                : {
                    cursor: "after",
                    events: [{ data: { id: "1", channel: "c", text: "after" } }],
                  },
            ),
        });

        const client = yield* Action.client(Stale);

        const received = yield* Effect.forEach(["stream", "poll"] as const, (mode) =>
          Effect.gen(function* () {
            const fiber = yield* client
              .watch(Posted, {}, { cursor: "old", mode })
              .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

            yield* TestClock.adjust("5 seconds");

            return yield* Fiber.join(fiber);
          }),
        );

        expect(received).toMatchObject(
          ["stream", "poll"].map(() => [
            { _tag: "Gap", cursor: "fresh" },
            { _tag: "Occurrence", data: { text: "after" }, cursor: "after" },
          ]),
        );
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "gives a truncated page's gap and earlier occurrences the stale cursor, streamed and polled, so resuming there reads the page again",
    () =>
      Effect.gen(function* () {
        const Stale = Event.implement(Posted, {
          check: (_input, cursor) =>
            Effect.succeed(
              cursor === "old"
                ? {
                    cursor: "fresh",
                    truncated: true,
                    events: ["a", "b"].map((id) => ({ data: { id, channel: "c", text: id } })),
                  }
                : { cursor: "fresh", events: [] },
            ),
        });

        const client = yield* Action.client(Stale);

        const received = yield* Effect.forEach(["stream", "poll"] as const, (mode) =>
          client.watch(Posted, {}, { cursor: "old", mode }).pipe(Stream.take(3), Stream.runCollect),
        );

        expect(received).toMatchObject(
          ["stream", "poll"].map(() => [
            { _tag: "Gap", cursor: "old" },
            { _tag: "Occurrence", data: { text: "a" }, cursor: "old" },
            { _tag: "Occurrence", data: { text: "b" }, cursor: "fresh" },
          ]),
        );
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "keeps its cursor under resume, a quiet poll's too, and a later watch resumes from it",
    () =>
      Effect.gen(function* () {
        const log = makeMessages();
        const client = yield* Action.client(log.implementation);
        const store = yield* KeyValueStore.KeyValueStore;
        const resume = { store, key: "posted" };

        const first = yield* client
          .watch(Posted, {}, { mode: "poll", resume })
          .pipe(Stream.runDrain, Effect.forkChild);

        yield* settle;
        expect(yield* store.get("posted")).toBe("0");
        log.post("general", "one");
        yield* TestClock.adjust("5 seconds");
        expect(yield* store.get("posted")).toBe("1");
        yield* Fiber.interrupt(first);

        log.post("general", "two");

        const second = yield* client
          .watch(Posted, {}, { mode: "poll", resume })
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

        yield* settle;

        expect(texts(yield* Fiber.join(second))).toEqual(["two"]);
      })
        .pipe(Effect.provide(KeyValueStore.layerMemory))
        .pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("keeps a quiet stream's cursor under resume as its pages move on", () =>
    Effect.gen(function* () {
      const log = makeMessages();
      const client = yield* Action.client(log.implementation);
      const store = yield* KeyValueStore.KeyValueStore;

      const fiber = yield* client
        .watch(Posted, { channel: "random" }, { resume: { store, key: "posted" } })
        .pipe(Stream.runDrain, Effect.forkChild);

      yield* settle;
      expect(yield* store.get("posted")).toBe("0");
      log.post("general", "unmatched");
      yield* TestClock.adjust("5 seconds");
      expect(yield* store.get("posted")).toBe("1");
      yield* Fiber.interrupt(fiber);
    })
      .pipe(Effect.provide(KeyValueStore.layerMemory))
      .pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "keeps an occurrence's cursor once the next is pulled, so one unhandled is received again",
    () =>
      Effect.gen(function* () {
        const log = makeMessages();
        const client = yield* Action.client(log.implementation);
        const store = yield* KeyValueStore.KeyValueStore;
        const resume = { store, key: "posted" };
        const keptWhileHandling: Array<string | undefined> = [];

        const fiber = yield* client.watch(Posted, {}, { mode: "poll", resume }).pipe(
          Stream.take(2),
          Stream.runForEach(() =>
            Effect.map(store.get("posted"), (kept) => keptWhileHandling.push(kept)),
          ),
          Effect.forkChild,
        );

        yield* settle;
        log.post("general", "one");
        yield* TestClock.adjust("5 seconds");
        log.post("general", "two");
        yield* TestClock.adjust("5 seconds");
        yield* Fiber.join(fiber);

        expect(keptWhileHandling).toEqual(["0", "1"]);

        const again = yield* client
          .watch(Posted, {}, { mode: "poll", resume })
          .pipe(Stream.take(1), Stream.runCollect);

        expect(texts(again)).toEqual(["two"]);
      })
        .pipe(Effect.provide(KeyValueStore.layerMemory))
        .pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("fails with what its resume store fails with", () =>
    Effect.gen(function* () {
      const log = makeMessages();
      const client = yield* Action.client(log.implementation);

      const failing: Event.CursorStore<"unavailable"> = {
        get: () => Effect.fail("unavailable"),
        set: () => Effect.fail("unavailable"),
      };

      const failure = yield* Effect.flip(
        Stream.runDrain(client.watch(Posted, {}, { resume: { store: failing, key: "posted" } })),
      );

      expect(failure).toBe("unavailable");
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  const makeFlaky = () => {
    const log = makeMessages();
    const asked: Array<string | null> = [];
    let refuse = false;

    const implementation = Event.implement(Posted, {
      check: (input, cursor) =>
        Effect.suspend(() => {
          asked.push(cursor);

          if (!refuse) return log.check(input, cursor);

          refuse = false;

          return Effect.fail(new Action.Unauthenticated());
        }),
    });

    return { log, asked, implementation, refuseNext: () => (refuse = true) };
  };

  it.effect("starts each run from its options, so a retry without resume starts from now", () =>
    Effect.gen(function* () {
      const flaky = makeFlaky();
      const client = yield* Action.client(flaky.implementation);

      const fiber = yield* client
        .watch(Posted)
        .pipe(
          Stream.retry(Schedule.recurs(1)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );

      yield* settle;
      flaky.log.post("general", "one");
      yield* TestClock.adjust("5 seconds");
      flaky.refuseNext();
      flaky.log.post("general", "two");
      yield* TestClock.adjust("5 seconds");
      flaky.log.post("general", "three");
      yield* TestClock.adjust("5 seconds");

      expect(texts(yield* Fiber.join(fiber))).toEqual(["one", "three"]);
      expect(flaky.asked).toEqual([null, "0", "1", null, "2"]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("goes on where a failed run stopped when retried with resume", () =>
    Effect.gen(function* () {
      const flaky = makeFlaky();
      const client = yield* Action.client(flaky.implementation);
      const store = yield* KeyValueStore.KeyValueStore;

      const fiber = yield* client
        .watch(Posted, {}, { resume: { store, key: "posted" } })
        .pipe(
          Stream.retry(Schedule.recurs(1)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );

      yield* settle;
      flaky.log.post("general", "one");
      yield* TestClock.adjust("5 seconds");
      flaky.refuseNext();
      flaky.log.post("general", "two");
      yield* TestClock.adjust("5 seconds");

      expect(texts(yield* Fiber.join(fiber))).toEqual(["one", "two"]);
      expect(flaky.asked).toEqual([null, "0", "1", "1"]);
    })
      .pipe(Effect.provide(KeyValueStore.layerMemory))
      .pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "reports a read that fails without a refusal once, and reads on from where it was, streamed and polled",
    () =>
      Effect.forEach(["stream", "poll"] as const, (mode) => {
        const reported: Array<string> = [];

        return Effect.gen(function* () {
          const log = makeMessages();
          let reads = 0;

          const failingSecondRead = Event.implement(Posted, {
            check: (input, cursor) =>
              (reads += 1) === 2
                ? Effect.die(new Error("upstream blew up"))
                : log.check(input, cursor),
          });

          const client = yield* Action.client(failingSecondRead);

          const fiber = yield* client
            .watch(Posted, {}, { mode })
            .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

          yield* settle;
          log.post("general", "one");
          yield* TestClock.adjust("5 seconds");
          yield* TestClock.adjust("5 seconds");

          expect([mode, texts(yield* Fiber.join(fiber)), reported.length]).toEqual([
            mode,
            ["one"],
            1,
          ]);
        }).pipe(
          Effect.provide(ErrorReporter.layer([recorder(reported)])),
          Effect.provide(Event.layerMemory),
        );
      }),
  );

  it.effect(
    "sends a Gap in place of an occurrence breaking its schema, reports it once, and reads on",
    () =>
      Effect.gen(function* () {
        const Counted = Event.make("counter.counted", {
          description: "A counter counted.",
          payload: { n: Schema.Int },
          caller: Action.Anyone,
        });

        const breakingBeforeValid = Event.implement(Counted, {
          check: (_input, cursor) =>
            Effect.succeed({
              cursor: "2",
              events:
                cursor === "2"
                  ? []
                  : [
                      { eventId: "c1", data: { n: 1.5 } },
                      { eventId: "c2", data: { n: 2 } },
                    ],
            }),
        });

        const client = yield* Action.client(breakingBeforeValid);

        for (const mode of ["stream", "poll"] as const) {
          const reported: Array<string> = [];

          const received = yield* client
            .watch(Counted, {}, { cursor: "0", mode })
            .pipe(
              Stream.take(2),
              Stream.runCollect,
              Effect.provide(ErrorReporter.layer([recorder(reported)])),
            );

          expect([mode, received, reported.length]).toMatchObject([
            mode,
            [{ _tag: "Gap" }, { _tag: "Occurrence", eventId: "c2" }],
            1,
          ]);
        }
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("drops an occurrence whose eventId it already delivered", () =>
    Effect.gen(function* () {
      const Repeating = Event.implement(Posted, {
        check: () =>
          Effect.succeed({
            cursor: "same",
            events: [{ eventId: "same", data: { id: "1", channel: "c", text: "again" } }],
          }),
      });

      const client = yield* Action.client(Repeating);
      const seen: Array<Received> = [];

      const fiber = yield* client.watch(Posted).pipe(
        Stream.runForEach((received) => Effect.sync(() => seen.push(received))),
        Effect.forkChild,
      );

      yield* TestClock.adjust("20 seconds");
      yield* Fiber.interrupt(fiber);

      expect(texts(seen)).toEqual(["again"]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("forgets the oldest of the last thousand ids it delivered", () =>
    Effect.gen(function* () {
      const message = (id: string) => ({ eventId: id, data: { id, channel: "c", text: id } });

      const Replaying = Event.implement(Posted, {
        check: (_input, cursor) =>
          Effect.succeed(
            Match.value(cursor).pipe(
              Match.when(null, () => ({ cursor: "0", events: [] })),
              Match.when("0", () => ({
                cursor: "1",
                events: Array.from({ length: 1001 }, (_, index) => message(`e${index}`)),
                hasMore: true,
              })),
              Match.orElse(() => ({ cursor: "2", events: [message("e0"), message("e1000")] })),
            ),
          ),
      });

      const client = yield* Action.client(Replaying);

      const fiber = yield* client
        .watch(Posted)
        .pipe(Stream.take(1002), Stream.runCollect, Effect.forkChild);

      yield* TestClock.adjust("5 seconds");

      expect(texts(yield* Fiber.join(fiber)).slice(-2)).toEqual(["e1000", "e0"]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("fails with NotServed for an event type the client was not given", () =>
    Effect.gen(function* () {
      const log = makeMessages();
      const client = yield* Action.client(log.implementation);

      const Other = Event.make("other.happened", {
        description: "",
        payload: {},
        caller: Action.Anyone,
      });

      const failure = yield* Effect.flip(
        // @ts-expect-error -- The failure under test: an event type no implementation given holds.
        Stream.runDrain(client.watch(Other)),
      );

      expect(failure).toEqual(
        new Event.SubscriptionError({
          event: "other.happened",
          reason: new Event.NotServed(),
          message: 'Event "other.happened" is not served',
        }),
      );
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("fails with InvalidInput, subscribing nothing, for input that does not encode", () =>
    Effect.gen(function* () {
      const log = makeMessages();
      const client = yield* Action.client(log.implementation);

      const failure = yield* Effect.flip(
        // @ts-expect-error -- The failure under test: input its schema refuses.
        Stream.runDrain(client.watch(Posted, { channel: 1 })),
      );

      expect(failure).toBeInstanceOf(Action.InvalidInput);
      expect(log.checks()).toBe(0);
    }).pipe(Effect.provide(Event.layerMemory)),
  );
});

describe("a log source fed by a stream, watched in process", () => {
  const makeTicker = Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Message>();

    const implementation = Event.implement(Posted, {
      log: {
        emit: Stream.fromQueue(queue).pipe(Stream.map((data) => ({ eventId: data.id, data }))),
      },
      match: ({ channel }, data) => channel === undefined || data.channel === channel,
      transform: ({ channel }, data) =>
        channel === undefined ? data : { ...data, text: data.text.toUpperCase() },
    });

    const emit = (id: string, channel: string, text: string) =>
      Effect.andThen(Queue.offer(queue, { id, channel, text }), settle);

    return { implementation, emit, queue };
  });

  it.effect(
    "streams what is emitted after it starts, as each subscriber's match and transform select",
    () =>
      Effect.gen(function* () {
        const ticker = yield* makeTicker;
        const client = yield* Action.client(ticker.implementation);

        const all = yield* client
          .watch(Posted)
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

        const random = yield* client
          .watch(Posted, { channel: "random" })
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

        yield* settle;
        yield* ticker.emit("1", "general", "one");
        yield* ticker.emit("2", "random", "two");

        expect(texts(yield* Fiber.join(all))).toEqual(["one", "two"]);
        expect(texts(yield* Fiber.join(random))).toEqual(["TWO"]);
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("replays what it kept from a cursor, after a gap for a cursor it never minted", () =>
    Effect.gen(function* () {
      const ticker = yield* makeTicker;
      const client = yield* Action.client(ticker.implementation);

      const first = yield* client
        .watch(Posted)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

      yield* settle;
      yield* ticker.emit("1", "general", "one");

      const [one] = yield* Fiber.join(first);
      const cursor = one?._tag === "Occurrence" ? one.cursor : null;

      yield* ticker.emit("2", "general", "two");

      const replayed = yield* client
        .watch(Posted, {}, { cursor })
        .pipe(Stream.take(1), Stream.runCollect);

      const fromForeign = yield* client
        .watch(Posted, {}, { cursor: "elsewhere:1" })
        .pipe(Stream.take(3), Stream.runCollect);

      expect(texts(replayed)).toEqual(["two"]);
      expect(texts(fromForeign)).toEqual(["gap", "one", "two"]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "gives an occurrence without an id or time the same on every read: when it arrived",
    () =>
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<Message>();

        const implementation = Event.implement(Posted, {
          log: { emit: Stream.fromQueue(queue).pipe(Stream.map((data) => ({ data }))) },
        });

        const client = yield* Action.client(implementation);

        const first = yield* client
          .watch(Posted)
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

        yield* settle;
        yield* Queue.offerAll(queue, [
          { id: "1", channel: "general", text: "one" },
          { id: "2", channel: "general", text: "two" },
        ]);
        yield* settle;

        const delivered = yield* Fiber.join(first);

        yield* TestClock.adjust("1 minute");

        const replayed = yield* client
          .watch(Posted, {}, { cursor: "elsewhere:1" })
          .pipe(Stream.take(3), Stream.drop(1), Stream.runCollect);

        const stamps = (received: ReadonlyArray<Received>) =>
          received.map((item) =>
            item._tag === "Gap" ? "gap" : [item.eventId, DateTime.toEpochMillis(item.timestamp)],
          );

        expect(stamps(replayed)).toEqual(stamps(delivered));
        expect(new Set(stamps(delivered).map(([eventId]) => eventId)).size).toBe(2);
        expect(stamps(delivered).map(([, at]) => at)).toEqual([0, 0]);
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("polls from a cursor as it streams", () =>
    Effect.gen(function* () {
      const ticker = yield* makeTicker;
      const client = yield* Action.client(ticker.implementation);

      const fiber = yield* client
        .watch(Posted, {}, { mode: "poll" })
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

      yield* settle;
      yield* ticker.emit("1", "general", "one");
      yield* ticker.emit("2", "general", "two");
      yield* TestClock.adjust("5 seconds");

      expect(texts(yield* Fiber.join(fiber))).toEqual(["one", "two"]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("hands a follower that falls behind what is kept a gap, then what is kept", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<Message>();
      const latch = yield* Latch.make(false);
      const emitted = ["1", "2", "3", "4", "5", "6", "7", "8"];

      const Bounded = Event.implement(Posted, {
        log: {
          emit: Stream.fromQueue(queue).pipe(Stream.map((data) => ({ eventId: data.id, data }))),
          maxEvents: 3,
        },
      });

      const client = yield* Action.client(Bounded);
      const received: Array<Received> = [];

      const fiber = yield* client.watch(Posted).pipe(
        Stream.takeUntil((each) => each._tag === "Occurrence" && each.data.text === "8"),
        Stream.runForEach((each) =>
          Effect.andThen(
            Effect.sync(() => received.push(each)),
            Effect.suspend(() => (received.length === 1 ? latch.await : Effect.void)),
          ),
        ),
        Effect.forkChild,
      );

      yield* settle;

      for (const id of emitted) {
        yield* Queue.offer(queue, { id, channel: "c", text: id });
        yield* settle;
      }

      yield* latch.open;
      yield* Fiber.join(fiber);

      const got = texts(received);
      const gap = got.indexOf("gap");

      expect(gap).toBeGreaterThan(0);
      expect(got.slice(0, gap)).toEqual(emitted.slice(0, gap));
      expect(got.slice(gap + 1)).toEqual(emitted.slice(-3));
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "hands every follower each emitted occurrence once, in order, from when it starts",
    () =>
      Effect.gen(function* () {
        const ticker = yield* makeTicker;
        const client = yield* Action.client(ticker.implementation);
        const emitted = Array.from({ length: 20 }, (_, index) => `${index}`);
        const followers: Array<{ readonly from: number; readonly got: Array<string> }> = [];

        for (const [index, id] of emitted.entries()) {
          if (index < 10) {
            const got: Array<string> = [];

            yield* client.watch(Posted).pipe(
              Stream.runForEach((each) => Effect.sync(() => got.push(...texts([each])))),
              Effect.forkChild,
            );
            yield* settle;
            followers.push({ from: index, got });
          }

          yield* ticker.emit(id, "c", id);
        }

        yield* settle;

        expect(followers.map(({ got }) => got)).toEqual(
          followers.map(({ from }) => emitted.slice(from)),
        );
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "reports a failure that ends a log's emit stream, logs an end, and still serves what each kept",
    () =>
      Effect.gen(function* () {
        const logged: Array<string> = [];
        const reportedCauses: Array<string> = [];
        const kept = Stream.make({ eventId: "1", data: { id: "1", channel: "c", text: "kept" } });

        const received = yield* Effect.forEach(
          [kept.pipe(Stream.concat(Stream.die("upstream gone"))), kept],
          (emit) =>
            Effect.gen(function* () {
              const client = yield* Action.client(Event.implement(Posted, { log: { emit } }));

              yield* settle;

              return texts(
                yield* client
                  .watch(Posted, {}, { cursor: "elsewhere:1", mode: "poll" })
                  .pipe(Stream.take(2), Stream.runCollect),
              );
            }),
        ).pipe(
          Effect.provide([
            Logger.layer([
              Logger.make(({ message }) => {
                logged.push(String(message));
              }),
            ]),
            ErrorReporter.layer([recorder(reportedCauses)]),
          ]),
        );

        expect(received).toEqual([
          ["gap", "kept"],
          ["gap", "kept"],
        ]);
        expect(reportedCauses).toEqual([expect.stringContaining("upstream gone")]);
        expect(logged).toContainEqual("A log source's emit stream ended: it appends nothing more");
      }).pipe(Effect.provide(Event.layerMemory)),
  );
});

describe("a subscription hook", () => {
  const makeHooked = () => {
    const log = makeMessages();
    const held: Array<string> = [];

    const implementation = Event.implement(Posted, {
      check: log.check,
      subscription: ({ channel }) =>
        Effect.acquireRelease(
          Effect.sync(() => held.push(channel ?? "all")),
          () => Effect.sync(() => held.splice(held.indexOf(channel ?? "all"), 1)),
        ),
    });

    return { log, held, implementation };
  };

  it.effect(
    "sets up the hook for each poll subscriber in process, even of one input, until its watch ends",
    () =>
      Effect.gen(function* () {
        const hooked = makeHooked();
        const client = yield* Action.client(hooked.implementation);
        const poll = client.watch(Posted, { channel: "a" }, { mode: "poll" });

        const fibers = yield* Effect.all([Stream.runDrain(poll), Stream.runDrain(poll)], {
          concurrency: "unbounded",
        }).pipe(Effect.forkChild);

        yield* settle;
        expect(hooked.held).toEqual(["a", "a"]);
        yield* Fiber.interrupt(fibers);
        expect(hooked.held).toEqual([]);
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("holds what it set up while a stream is read, and tears it down when it ends", () =>
    Effect.gen(function* () {
      const hooked = makeHooked();
      const client = yield* Action.client(hooked.implementation);

      const fiber = yield* client
        .watch(Posted, { channel: "a" })
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

      yield* settle;
      expect(hooked.held).toEqual(["a"]);
      hooked.log.post("a", "one");
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(fiber);

      expect(hooked.held).toEqual([]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );
});

describe("a protected event type", () => {
  const Changed = Event.make("user.changed", {
    description: "A user of the subscriber's tenant changed.",
    payload: { actorId: Schema.String },
    caller: CurrentActor,
  });

  let checked = 0;

  const changes = Event.implement(
    Changed,
    {
      check: () =>
        Effect.map(CurrentActor, (actor) => {
          checked += 1;

          return { cursor: "0", events: [{ data: { actorId: actor.id } }] };
        }),
    },
    {
      authorize: () =>
        Effect.flatMap(CurrentActor, (actor) =>
          actor.permissions.includes("users:write")
            ? Effect.void
            : Effect.fail(new Action.Forbidden({ message: "Requires users:write." })),
        ),
    },
  );

  it("refuses a subscriber without an identity, its source never running", async () => {
    checked = 0;

    const exit = await Effect.runPromiseExit(
      // @ts-expect-error -- Deliberately subscribe without a caller.
      Effect.scoped(
        Effect.flatMap(Action.client(changes), (client) => Stream.runHead(client.watch(Changed))),
      ).pipe(Effect.provide(Event.layerMemory)),
    );

    expect(Exit.isFailure(exit) && Exit.findErrorOption(exit)).toEqual(
      Option.some(new Action.Unauthenticated()),
    );
    expect(checked).toBe(0);
  });

  it.effect("refuses a subscriber authorize refuses, and runs as one it admits", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(changes);
      const first = Stream.runHead(client.watch(Changed));

      expect(
        yield* Effect.flip(Effect.provideService(first, CurrentActor, actors.reader)),
      ).toBeInstanceOf(Action.Forbidden);
      expect(
        Option.getOrThrow(yield* Effect.provideService(first, CurrentActor, actors.alice)),
      ).toMatchObject({ data: { actorId: "alice" } });
    }).pipe(Effect.provide(Event.layerMemory)),
  );
});
