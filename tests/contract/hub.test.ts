import { describe, expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import {
  DateTime,
  Effect,
  Exit,
  Fiber,
  Layer,
  PubSub,
  Schema,
  Scope,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";

import { memoryStorage } from "../../src/contract/log.js";
import { makeMessages, Posted, settle, texts } from "../support/events.js";
import type { Message } from "../support/events.js";

const Key = Schema.UndefinedOr(Schema.Literals(["a", "b"]));

const Published = Schema.Struct({ key: Key, text: Schema.String });

const logged = Event.implement(Posted, {
  log: {},
  key: ({ channel }) => channel,
  match: ({ channel }, data) =>
    channel === undefined || data.channel === channel,
});

describe("Event.Events.notify", () => {
  it.effect(
    "wakes a check source's streamed subscribers to read now, not at their next poll",
    () =>
      Effect.gen(function* () {
        const store = makeMessages();
        const client = yield* Action.client(store.implementation);
        const events = yield* Event.Events;

        const watching = yield* client
          .watch(Posted, { channel: "general" })
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

        yield* settle;
        store.post("general", "one");
        yield* events.notify(Posted);

        expect(texts(yield* Fiber.join(watching))).toStrictEqual(["one"]);
      }).pipe(Effect.provide(Event.layerMemory))
  );

  it.effect(
    "reads again at once for a notify that arrives while a read runs",
    () =>
      Effect.gen(function* () {
        const events = yield* Event.Events;
        const messages: Message[] = [];
        let reads = 0;

        const racing = Event.implement(Posted, {
          check: (_input, cursor) =>
            Effect.gen(function* () {
              reads += 1;

              const seen = cursor === null ? messages.length : Number(cursor);

              const page = {
                cursor: String(messages.length),
                events: messages
                  .slice(seen)
                  .map((data) => ({ eventId: data.id, data })),
              };

              if (reads === 2) {
                messages.push({ id: "m1", channel: "general", text: "one" });
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
        expect(texts(yield* Fiber.join(watching))).toStrictEqual(["one"]);
      }).pipe(Effect.provide(Event.layerMemory))
  );

  it.effect(
    "wakes the subscribers of the key notified, and those following every key",
    () =>
      Effect.gen(function* () {
        const store = makeMessages();
        const client = yield* Action.client(store.implementation);
        const events = yield* Event.Events;

        const general = yield* client
          .watch(Posted, { channel: "general" })
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

        const everywhere = yield* client
          .watch(Posted, {})
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

        yield* client
          .watch(Posted, { channel: "random" })
          .pipe(Stream.runDrain, Effect.forkChild);
        yield* settle;

        const randomReads = store.readsOf("random");

        store.post("general", "one");
        yield* events.notify(Posted, { key: "general" });

        expect([
          texts(yield* Fiber.join(general)),
          texts(yield* Fiber.join(everywhere)),
        ]).toStrictEqual([["one"], ["one"]]);
        expect(store.readsOf("random")).toBe(randomReads);
      }).pipe(Effect.provide(Event.layerMemory))
  );
});

const stamps = (received: ReadonlyArray<Event.Received<typeof Posted>>) =>
  received.map((item) =>
    item._tag === "Gap"
      ? "gap"
      : [item.eventId, DateTime.toEpochMillis(item.timestamp)]
  );

describe("Event.Events.publish", () => {
  it.effect(
    "delivers what is published to a log source at once, and to a poll at its next",
    () =>
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
        yield* events.publish(Posted, {
          data: { id: "m1", channel: "general", text: "one" },
        });
        yield* events.publish(Posted, {
          data: { id: "m2", channel: "random", text: "two" },
        });

        expect(texts(yield* Fiber.join(streamed))).toStrictEqual([
          "one",
          "two",
        ]);

        yield* TestClock.adjust("5 seconds");

        expect(texts(yield* Fiber.join(polled))).toStrictEqual(["one", "two"]);
      }).pipe(Effect.provide(Event.layerMemory))
  );

  it.effect(
    "gives a published occurrence without an id or time its cursor and when it was published, for every subscriber and replay",
    () =>
      Effect.gen(function* () {
        const client = yield* Action.client(logged);
        const events = yield* Event.Events;

        const watching = client
          .watch(Posted, {})
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

        const [first, second] = [yield* watching, yield* watching];

        yield* settle;
        yield* TestClock.adjust("1 minute");
        yield* events.publish(Posted, {
          data: { id: "m1", channel: "general", text: "one" },
        });
        yield* TestClock.adjust("1 minute");

        const replayed = yield* client
          .watch(Posted, {}, { cursor: "elsewhere:1" })
          .pipe(Stream.take(2), Stream.drop(1), Stream.runCollect);

        const delivered = yield* Fiber.join(first);
        const [one] = delivered;

        if (one?._tag !== "Occurrence") {
          throw new Error("Expected an occurrence");
        }

        expect(
          [delivered, yield* Fiber.join(second), replayed].map(stamps)
        ).toStrictEqual([
          [[one.cursor, 60_000]],
          [[one.cursor, 60_000]],
          [[one.cursor, 60_000]],
        ]);
      }).pipe(Effect.provide(Event.layerMemory))
  );

  it.effect.prop(
    "gives each subscriber exactly the occurrences published or emitted to its key or to none, in order",
    {
      published: Schema.Array(Published).check(Schema.isMaxLength(12)),
      channel: Key,
      emitted: Schema.Boolean,
    },
    ({ published, channel, emitted }) =>
      Effect.gen(function* () {
        const upstream = yield* PubSub.unbounded<
          Event.Emitted<typeof Posted> & Event.KeyOptions
        >();

        const keyed = Event.implement(Posted, {
          log: emitted ? { emit: Stream.fromPubSub(upstream) } : {},
          key: (input) => input.channel,
        });

        const client = yield* Action.client(keyed);
        const events = yield* Event.Events;

        const expected = published.filter(
          ({ key }) =>
            key === undefined || channel === undefined || key === channel
        );

        const watching = yield* client
          .watch(Posted, channel === undefined ? {} : { channel })
          .pipe(
            Stream.take(expected.length),
            Stream.runCollect,
            Effect.forkChild
          );

        yield* settle;

        for (const [index, { key, text }] of published.entries()) {
          const data = { id: `m${index}`, channel: key ?? "", text };

          yield* emitted
            ? PubSub.publish(upstream, { data, key })
            : events.publish(
                Posted,
                { data },
                key === undefined ? undefined : { key }
              );
        }

        expect(texts(yield* Fiber.join(watching))).toStrictEqual(
          expected.map(({ text }) => text)
        );
      }).pipe(Effect.provide(Event.layerMemory))
  );
});

describe("Event.Events", () => {
  it.effect(
    "dies naming the other verb where the source is of the other kind",
    () =>
      Effect.gen(function* () {
        const store = makeMessages();
        const events = yield* Event.Events;

        yield* Action.client(store.implementation);

        const published = yield* Effect.flip(
          Effect.sandbox(
            events.publish(Posted, {
              data: { id: "m1", channel: "general", text: "one" },
            })
          )
        );

        expect(String(published)).toContain(
          'Event "message.posted" has a check source, which reads your store: write the occurrence there, then wake its subscribers (Event.Events.notify(event))'
        );
      }).pipe(Effect.provide(Event.layerMemory))
  );

  it.effect(
    "dies as an implementation builds over an Events neither layer made",
    () =>
      Effect.gen(function* () {
        const built = yield* Effect.exit(Effect.scoped(Action.client(logged)));

        expect(String(Exit.isFailure(built) ? built.cause : "")).toContain(
          "This Event.Events serves no event implementation: provide Event.layerMemory, or one Event.makeEvents builds"
        );
      }).pipe(
        Effect.provide(
          Layer.succeed(
            Event.Events,
            Event.Events.of({
              notify: () => Effect.void,
              publish: () => Effect.void,
            })
          )
        )
      )
  );

  it.effect("dies at a notify of a log source, naming publish", () =>
    Effect.gen(function* () {
      const events = yield* Event.Events;

      yield* Action.client(logged);

      const notified = yield* Effect.flip(
        Effect.sandbox(events.notify(Posted))
      );

      expect(String(notified)).toContain(
        "has a log source, which keeps what is published"
      );
    }).pipe(Effect.provide(Event.layerMemory))
  );

  it.effect(
    "lets notify and publish succeed for an event attached nowhere here, publish included once its check source is released",
    () =>
      Effect.gen(function* () {
        const events = yield* Event.Events;

        const publish = events.publish(Posted, {
          data: { id: "m1", channel: "general", text: "one" },
        });

        const unattached = yield* Effect.exit(
          Effect.andThen(events.notify(Posted), publish)
        );

        yield* Effect.scoped(Action.client(makeMessages().implementation));

        const released = yield* Effect.exit(publish);

        expect([unattached, released]).toStrictEqual([Exit.void, Exit.void]);
      }).pipe(Effect.provide(Event.layerMemory))
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
            yield* events.publish(Posted, {
              data: { id: "m1", channel: "general", text: "one" },
            });

            return yield* Fiber.join(watching);
          })
        );

        yield* events.publish(Posted, {
          data: { id: "m2", channel: "general", text: "two" },
        });

        const [one] = first;

        if (one?._tag !== "Occurrence") {
          throw new Error("Expected an occurrence");
        }

        const client = yield* Action.client(logged);

        const resumed = yield* client
          .watch(Posted, {}, { cursor: one.cursor })
          .pipe(Stream.take(1), Stream.runCollect);

        expect(texts(resumed)).toStrictEqual(["two"]);
      }).pipe(Effect.provide(Event.layerMemory))
  );

  it.effect(
    "hands a log's emit on to the next held implementation however many are released",
    () =>
      Effect.gen(function* () {
        const upstream = yield* PubSub.unbounded<Message>();

        const emitted = () =>
          Event.implement(Posted, {
            log: {
              emit: Stream.fromPubSub(upstream).pipe(
                Stream.map((data) => ({ data }))
              ),
            },
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
        yield* PubSub.publish(upstream, {
          id: "m1",
          channel: "general",
          text: "one",
        });

        expect(texts(yield* Fiber.join(watching))).toStrictEqual(["one"]);
      }).pipe(Effect.provide(Event.layerMemory))
  );

  it.effect(
    "feeds a log from one implementation's emit at a time, past its release, losing nothing published as it is released",
    () =>
      Effect.gen(function* () {
        const upstream = yield* PubSub.unbounded<Message>();

        const emitted = () =>
          Event.implement(Posted, {
            log: {
              emit: Stream.fromPubSub(upstream).pipe(
                Stream.map((data) => ({ data }))
              ),
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
        yield* PubSub.publish(upstream, {
          id: "m1",
          channel: "general",
          text: "one",
        });
        yield* settle;
        yield* Scope.close(released, Exit.void);
        yield* PubSub.publish(upstream, {
          id: "m2",
          channel: "general",
          text: "two",
        });

        expect(texts(yield* Fiber.join(watching))).toStrictEqual([
          "one",
          "two",
        ]);
      }).pipe(Effect.provide(Event.layerMemory))
  );
});

type Storage = Event.LogStorage<Event.Emitted<Event.Any>>;

type Kept = NonNullable<Parameters<Storage["put"]>[1]>;

const recordingStorage = () => {
  let position: Parameters<Storage["put"]>[0] | undefined;
  const kept: Kept[] = [];

  const storage: Storage = {
    position: Effect.sync(() => position),
    put: (next, entry) =>
      Effect.sync(() => {
        position = next;

        if (entry !== undefined) {
          kept.push(entry);
        }
      }),
    list: (from, limit) =>
      Effect.sync(() =>
        kept
          .filter(({ seq }) => seq >= from)
          .slice(0, limit)
          .map(({ seq, stored }) => [seq, stored] as const)
      ),
    delete: (seqs) =>
      Effect.sync(() => {
        kept.splice(
          0,
          kept.length,
          ...kept.filter(({ seq }) => !seqs.includes(seq))
        );
      }),
  };

  return { kept, storage };
};

describe("Event.makeEvents", () => {
  it.effect(
    "moves the revision at a notify of a current source, and none of a check source",
    () =>
      Effect.gen(function* () {
        let bumps = 0;

        const Status = Event.make("status.changed", {
          description: "A status changed.",
          payload: { value: Schema.Int },
          caller: Action.Anyone,
        });

        const layer = Layer.effect(Event.Events)(
          Event.makeEvents({
            log: () => memoryStorage(),
            revisions: {
              epoch: "epoch",
              get: () => Effect.succeed(0),
              bump: () =>
                Effect.sync(() => {
                  bumps += 1;
                }),
            },
          })
        );

        yield* Effect.gen(function* () {
          const events = yield* Event.Events;

          yield* Action.client(makeMessages().implementation);
          yield* Action.client(
            Event.implement(Status, {
              current: () => Effect.succeed({ value: 0 }),
            })
          );
          yield* events.notify(Posted);
          expect(bumps).toBe(0);
          yield* events.notify(Status);
          expect(bumps).toBe(1);
        }).pipe(Effect.provide(layer));
      })
  );

  it.effect(
    "keeps a log source's entries, with their keys, in the storage its log option makes, and reads them from it",
    () =>
      Effect.gen(function* () {
        const { kept, storage } = recordingStorage();
        const made: string[] = [];

        const layer = Layer.effect(Event.Events)(
          Event.makeEvents({
            log: (event) => {
              made.push(event.name);

              return storage;
            },
          })
        );

        const received = yield* Effect.gen(function* () {
          const client = yield* Action.client(logged);
          const events = yield* Event.Events;

          const watching = yield* client
            .watch(Posted, {})
            .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

          yield* settle;
          yield* events.publish(
            Posted,
            { data: { id: "m1", channel: "a", text: "one" } },
            { key: "a" }
          );
          yield* events.publish(Posted, {
            data: { id: "m2", channel: "b", text: "two" },
          });

          return yield* Fiber.join(watching);
        }).pipe(Effect.provide(layer));

        expect(texts(received)).toStrictEqual(["one", "two"]);
        expect(made).toStrictEqual([Posted.name]);
        expect(
          kept.map(({ seq, stored }) => [seq, stored.logged.key])
        ).toStrictEqual([
          [1, "a"],
          [2, undefined],
        ]);
      })
  );

  it.effect(
    "reads a check source only as it subscribes and when notified, where polls is false",
    () =>
      Effect.gen(function* () {
        const store = makeMessages();

        const layer = Layer.effect(Event.Events)(
          Event.makeEvents({ log: () => memoryStorage(), polls: false })
        );

        const [quiet, received, reads] = yield* Effect.gen(function* () {
          const client = yield* Action.client(store.implementation);
          const events = yield* Event.Events;

          const watching = yield* client
            .watch(Posted, { channel: "general" })
            .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

          yield* settle;
          store.post("general", "one");
          yield* TestClock.adjust("10 minutes");

          const unnotified = store.readsOf("general");

          yield* events.notify(Posted, { key: "general" });

          return [
            unnotified,
            yield* Fiber.join(watching),
            store.readsOf("general"),
          ] as const;
        }).pipe(Effect.provide(layer));

        expect(quiet).toBe(1);
        expect(texts(received)).toStrictEqual(["one"]);
        expect(reads).toBe(2);
      })
  );
});
