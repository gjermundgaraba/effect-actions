import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Layer, PubSub, Schema, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";

const Posted = Event.make("message.posted", {
  description: "A message was posted.",
  input: { room: Schema.optional(Schema.String) },
  payload: { id: Schema.String, room: Schema.String, text: Schema.String },
  caller: Action.Anyone,
});

type Message = typeof Posted.payload.Type;

const settle = TestClock.adjust("0 millis");

const texts = (received: ReadonlyArray<Event.Received<typeof Posted>>) =>
  received.map((item) => (item._tag === "Gap" ? "gap" : item.data.text));

const makeCountedStore = () => {
  const messages: Array<Message> = [];
  const reads = new Map<string, number>();

  const post = (room: string, text: string) =>
    messages.push({ id: `m${messages.length + 1}`, room, text });

  const implementation = Event.implement(Posted, {
    check: ({ room }, cursor) =>
      Effect.sync(() => {
        reads.set(room ?? "*", (reads.get(room ?? "*") ?? 0) + 1);

        const seen = cursor === null ? messages.length : Number(cursor);

        return {
          cursor: String(messages.length),
          events: messages
            .slice(seen)
            .filter((message) => room === undefined || message.room === room)
            .map((data) => ({ eventId: data.id, data })),
        };
      }),
    key: ({ room }) => room,
  });

  return { post, implementation, readsOf: (room: string) => reads.get(room) ?? 0 };
};

const Key = Schema.UndefinedOr(Schema.Literals(["a", "b"]));

const Published = Schema.Struct({ key: Key, text: Schema.String });

const logged = Event.implement(Posted, {
  log: {},
  key: ({ room }) => room,
  match: ({ room }, data) => room === undefined || data.room === room,
});

describe("Event.Events.notify", () => {
  it.effect("wakes a check source's streamed subscribers to read now, not at their next poll", () =>
    Effect.gen(function* () {
      const store = makeCountedStore();
      const client = yield* Action.client(store.implementation);
      const events = yield* Event.Events;

      const watching = yield* client
        .watch(Posted, { room: "general" })
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

      yield* settle;
      store.post("general", "one");
      yield* events.notify(Posted);

      expect(texts(yield* Fiber.join(watching))).toEqual(["one"]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("reads again at once for a notify that arrives while a read runs", () =>
    Effect.gen(function* () {
      const events = yield* Event.Events;
      const messages: Array<Message> = [];
      let reads = 0;

      const racing = Event.implement(Posted, {
        check: (_input, cursor) =>
          Effect.gen(function* () {
            reads += 1;

            const seen = cursor === null ? messages.length : Number(cursor);

            const page = {
              cursor: String(messages.length),
              events: messages.slice(seen).map((data) => ({ eventId: data.id, data })),
            };

            if (reads === 2) {
              messages.push({ id: "m1", room: "general", text: "one" });
              yield* events.notify(Posted);
            }

            return page;
          }),
      });

      const client = yield* Action.client(racing);

      const watching = yield* client
        .watch(Posted, {})
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

      yield* settle;
      yield* events.notify(Posted);
      yield* settle;

      expect(watching.pollUnsafe()).toBeDefined();
      expect(texts(yield* Fiber.join(watching))).toEqual(["one"]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("wakes the subscribers of the key notified, and those following every key", () =>
    Effect.gen(function* () {
      const store = makeCountedStore();
      const client = yield* Action.client(store.implementation);
      const events = yield* Event.Events;

      const general = yield* client
        .watch(Posted, { room: "general" })
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

      const everywhere = yield* client
        .watch(Posted, {})
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

      yield* client.watch(Posted, { room: "random" }).pipe(Stream.runDrain, Effect.forkChild);
      yield* settle;

      const randomReads = store.readsOf("random");

      store.post("general", "one");
      yield* events.notify(Posted, { key: "general" });

      expect([texts(yield* Fiber.join(general)), texts(yield* Fiber.join(everywhere))]).toEqual([
        ["one"],
        ["one"],
      ]);
      expect(store.readsOf("random")).toBe(randomReads);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("still reads at each poll without a notify", () =>
    Effect.gen(function* () {
      const store = makeCountedStore();
      const client = yield* Action.client(store.implementation);

      const watching = yield* client
        .watch(Posted, {})
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

      yield* settle;
      store.post("general", "one");
      yield* TestClock.adjust("5 seconds");

      expect(texts(yield* Fiber.join(watching))).toEqual(["one"]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );
});

describe("Event.Events.publish", () => {
  it.effect("delivers what is published to a log source at once, and to a poll at its next", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(logged);
      const events = yield* Event.Events;

      const streamed = yield* client
        .watch(Posted, {})
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

      const polled = yield* client
        .watch(Posted, {}, { mode: "poll" })
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

      yield* settle;
      yield* events.publish(Posted, { data: { id: "m1", room: "general", text: "one" } });
      yield* events.publish(Posted, { data: { id: "m2", room: "random", text: "two" } });

      expect(texts(yield* Fiber.join(streamed))).toEqual(["one", "two"]);

      yield* TestClock.adjust("5 seconds");

      expect(texts(yield* Fiber.join(polled))).toEqual(["one", "two"]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("keeps an occurrence's id and time for every subscriber, and resumes by cursor", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(logged);
      const events = yield* Event.Events;

      const first = yield* client
        .watch(Posted, {})
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

      yield* settle;
      yield* events.publish(Posted, { data: { id: "m1", room: "general", text: "one" } });
      yield* events.publish(Posted, { data: { id: "m2", room: "general", text: "two" } });

      const [one] = yield* Fiber.join(first);

      if (one?._tag !== "Occurrence") throw new Error("Expected an occurrence");

      const resumed = yield* client
        .watch(Posted, {}, { cursor: one.cursor })
        .pipe(Stream.take(1), Stream.runCollect);

      expect(texts(resumed)).toEqual(["two"]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect.prop(
    "gives each subscriber exactly the occurrences published to its key or to none, in order",
    { published: Schema.Array(Published).check(Schema.isMaxLength(12)), room: Key },
    ({ published, room }) =>
      Effect.gen(function* () {
        const keyed = Event.implement(Posted, { log: {}, key: ({ room }) => room });
        const client = yield* Action.client(keyed);
        const events = yield* Event.Events;

        const expected = published.filter(
          ({ key }) => key === undefined || room === undefined || key === room,
        );

        const watching = yield* client
          .watch(Posted, room === undefined ? {} : { room })
          .pipe(Stream.take(expected.length), Stream.runCollect, Effect.forkChild);

        yield* settle;

        for (const [index, { key, text }] of published.entries()) {
          yield* events.publish(
            Posted,
            { data: { id: `m${index}`, room: key ?? "", text } },
            key === undefined ? undefined : { key },
          );
        }

        expect(texts(yield* Fiber.join(watching))).toEqual(expected.map(({ text }) => text));
      }).pipe(Effect.provide(Event.layerMemory)),
  );
});

describe("Event.Events", () => {
  it.effect("dies naming the other verb where the source is of the other kind", () =>
    Effect.gen(function* () {
      const store = makeCountedStore();
      const events = yield* Event.Events;

      yield* Action.client(store.implementation);

      const published = yield* Effect.flip(
        Effect.sandbox(
          events.publish(Posted, { data: { id: "m1", room: "general", text: "one" } }),
        ),
      );

      expect(String(published)).toContain(
        'Event "message.posted" has a check source, which reads your store: write the occurrence there, then wake its subscribers (Event.Events.notify(event))',
      );
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("dies as an implementation builds over an Events neither layer made", () =>
    Effect.gen(function* () {
      const built = yield* Effect.exit(Effect.scoped(Action.client(logged)));

      expect(String(Exit.isFailure(built) ? built.cause : "")).toContain(
        "This Event.Events serves no event implementation: provide Event.layerMemory, or one Event.makeEvents builds",
      );
    }).pipe(
      Effect.provide(
        Layer.succeed(
          Event.Events,
          Event.Events.of({ notify: () => Effect.void, publish: () => Effect.void }),
        ),
      ),
    ),
  );

  it.effect("dies at a notify of a log source, naming publish", () =>
    Effect.gen(function* () {
      const events = yield* Event.Events;

      yield* Action.client(logged);

      const notified = yield* Effect.flip(Effect.sandbox(events.notify(Posted)));

      expect(String(notified)).toContain("has a log source, which keeps what is published");
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "does nothing for an event no implementation attached here, or no check any longer",
    () =>
      Effect.gen(function* () {
        const events = yield* Event.Events;

        yield* events.notify(Posted);
        yield* events.publish(Posted, { data: { id: "m1", room: "general", text: "one" } });
        yield* Effect.scoped(Action.client(makeCountedStore().implementation));
        yield* events.notify(Posted);
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "keeps a log source's log beyond the build attached to it, a cursor resuming in the next",
    () =>
      Effect.gen(function* () {
        const events = yield* Event.Events;

        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* Action.client(logged);

            const watching = yield* client
              .watch(Posted, {})
              .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

            yield* settle;
            yield* events.publish(Posted, { data: { id: "m1", room: "general", text: "one" } });

            return yield* Fiber.join(watching);
          }),
        );

        yield* events.publish(Posted, { data: { id: "m2", room: "general", text: "two" } });

        const [one] = first;

        if (one?._tag !== "Occurrence") throw new Error("Expected an occurrence");

        const client = yield* Action.client(logged);

        const resumed = yield* client
          .watch(Posted, {}, { cursor: one.cursor })
          .pipe(Stream.take(1), Stream.runCollect);

        expect(texts(resumed)).toEqual(["two"]);
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("hands a log's emit on to the next held implementation however many are released", () =>
    Effect.gen(function* () {
      const upstream = yield* PubSub.unbounded<Message>();

      const emitted = () =>
        Event.implement(Posted, {
          log: { emit: Stream.fromPubSub(upstream).pipe(Stream.map((data) => ({ data }))) },
        });

      const [first, second] = [yield* Scope.make(), yield* Scope.make()];

      yield* Action.client(emitted()).pipe(Scope.provide(first));
      yield* Action.client(emitted()).pipe(Scope.provide(second));

      const watcher = yield* Action.client(emitted());

      const watching = yield* watcher
        .watch(Posted, {})
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

      yield* settle;
      yield* Scope.close(first, Exit.void);
      yield* settle;
      yield* Scope.close(second, Exit.void);
      yield* settle;
      yield* PubSub.publish(upstream, { id: "m1", room: "general", text: "one" });

      expect(texts(yield* Fiber.join(watching))).toEqual(["one"]);
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "feeds a log from one implementation's emit at a time, the next taking over as it is released",
    () =>
      Effect.gen(function* () {
        const upstream = yield* PubSub.unbounded<Message>();

        const emitted = () =>
          Event.implement(Posted, {
            log: {
              emit: Stream.fromPubSub(upstream).pipe(Stream.map((data) => ({ data }))),
            },
          });

        const released = yield* Scope.make();

        yield* Action.client(emitted()).pipe(Scope.provide(released));

        const watcher = yield* Action.client(emitted());

        yield* Action.client(emitted());

        const watching = yield* watcher
          .watch(Posted, {})
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

        yield* settle;
        yield* PubSub.publish(upstream, { id: "m1", room: "general", text: "one" });
        yield* settle;
        yield* Scope.close(released, Exit.void);
        yield* settle;
        yield* PubSub.publish(upstream, { id: "m2", room: "general", text: "two" });

        expect(texts(yield* Fiber.join(watching))).toEqual(["one", "two"]);
      }).pipe(Effect.provide(Event.layerMemory)),
  );
});

type Storage = Event.LogStorage<Event.Emitted<Event.Any>>;

type Kept = NonNullable<Parameters<Storage["put"]>[1]>;

const recordingStorage = () => {
  let position: Parameters<Storage["put"]>[0] | undefined;
  const kept: Array<Kept> = [];

  const storage: Storage = {
    position: Effect.sync(() => position),
    put: (next, entry) =>
      Effect.sync(() => {
        position = next;

        if (entry !== undefined) kept.push(entry);
      }),
    list: (from, limit) =>
      Effect.sync(() =>
        kept
          .filter(({ seq }) => seq >= from)
          .slice(0, limit)
          .map(({ seq, stored }) => [seq, stored] as const),
      ),
    delete: (seqs) =>
      Effect.sync(() => {
        kept.splice(0, kept.length, ...kept.filter(({ seq }) => !seqs.includes(seq)));
      }),
  };

  return { kept, storage };
};

describe("Event.makeEvents", () => {
  it.effect(
    "keeps a log source's entries in the storage its log option makes, read back by its cursors",
    () =>
      Effect.gen(function* () {
        const { kept, storage } = recordingStorage();
        const made: Array<string> = [];

        const layer = Layer.effect(Event.Events)(
          Event.makeEvents({
            log: (event) => {
              made.push(event.name);

              return storage;
            },
          }),
        );

        const [received, resumed] = yield* Effect.gen(function* () {
          const client = yield* Action.client(logged);
          const events = yield* Event.Events;

          const watching = yield* client
            .watch(Posted, {})
            .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

          yield* settle;
          yield* events.publish(
            Posted,
            { data: { id: "m1", room: "a", text: "one" } },
            { key: "a" },
          );
          yield* events.publish(Posted, { data: { id: "m2", room: "b", text: "two" } });

          const both = yield* Fiber.join(watching);
          const [first] = both;

          if (first?._tag !== "Occurrence") throw new Error("Expected an occurrence");

          return [
            both,
            yield* client
              .watch(Posted, {}, { cursor: first.cursor })
              .pipe(Stream.take(1), Stream.runCollect),
          ] as const;
        }).pipe(Effect.provide(layer));

        expect(texts(received)).toEqual(["one", "two"]);
        expect(texts(resumed)).toEqual(["two"]);
        expect(made).toEqual([Posted.name]);
        expect(kept.map(({ seq, stored }) => [seq, stored.logged.key])).toEqual([
          [1, "a"],
          [2, undefined],
        ]);
      }),
  );

  it.effect(
    "reads a check source only as it subscribes and when notified, where polls is false",
    () =>
      Effect.gen(function* () {
        const store = makeCountedStore();

        const layer = Layer.effect(Event.Events)(
          Event.makeEvents({ log: () => recordingStorage().storage, polls: false }),
        );

        const [quiet, received, reads] = yield* Effect.gen(function* () {
          const client = yield* Action.client(store.implementation);
          const events = yield* Event.Events;

          const watching = yield* client
            .watch(Posted, { room: "general" })
            .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

          yield* settle;
          store.post("general", "one");
          yield* TestClock.adjust("10 minutes");

          const unnotified = store.readsOf("general");

          yield* events.notify(Posted, { key: "general" });

          return [unnotified, yield* Fiber.join(watching), store.readsOf("general")] as const;
        }).pipe(Effect.provide(layer));

        expect(quiet).toBe(1);
        expect(texts(received)).toEqual(["one"]);
        expect(reads).toBe(2);
      }),
  );
});
