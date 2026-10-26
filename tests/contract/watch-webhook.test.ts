import { describe, expect, it } from "@effect/vitest";
import { Data, Deferred, Effect, Exit, Fiber, Layer, Predicate, Schema, Stream } from "effect";
import { KeyValueStore } from "effect/persistence";
import { TestClock } from "effect/testing";
import * as Action from "../../src/contract/Action.js";
import { WebhookSecret } from "../../src/contract/callback.js";
import * as Event from "../../src/contract/Event.js";
import {
  type Grant,
  type Transport,
  watching,
  type WebhookRequest,
} from "../../src/contract/watch.js";
import { type Delivered, Receiving, webhookFed } from "../../src/contract/receiving.js";
import { secretOf, settled } from "../support/webhook.js";

const Changed = Event.make("user.changed", {
  description: "A user changed.",
  payload: { id: Schema.String },
  caller: Action.Anyone,
});

class Blip extends Data.TaggedError("Blip")<{}> {}

interface Server {
  readonly requests: Array<WebhookRequest>;
  readonly answers: Array<Effect.Effect<Grant, Blip>>;
  readonly unsubscribed: Array<string>;
  unsubscribe: Effect.Effect<void>;
  deliver: (body: Delivered) => boolean;
  registered: number;
}

const makeServer = (...answers: Array<Effect.Effect<Grant, Blip>>): Server => ({
  requests: [],
  answers,
  unsubscribed: [],
  unsubscribe: Effect.void,
  deliver: () => false,
  registered: 0,
});

const grant = (cursor: string, refreshInMs: number | null, truncated = false) =>
  Effect.succeed({
    cursor,
    truncated,
    refreshBefore: refreshInMs === null ? null : new Date(refreshInMs).toISOString(),
  });

const transportOf = (server: Server): Transport<unknown, Receiving> => ({
  name: Changed.name,
  poll: () => Effect.die("A watch by webhook polled"),
  stream: () => Stream.die("A watch by webhook streamed"),
  webhook: {
    receiver: Effect.service(Receiving),
    subscribe: (request) =>
      Effect.suspend(() => {
        server.requests.push(request);

        return server.answers.shift() ?? grant(request.cursor ?? "0", null);
      }),
    unsubscribe: ({ delivery }) =>
      Effect.suspend(() => {
        server.unsubscribed.push(delivery.url.href);

        return server.unsubscribe;
      }),
    read: webhookFed(Changed),
  },
  transient: Predicate.isTagged("Blip"),
});

const secret = Schema.decodeSync(WebhookSecret)(secretOf(1));

const receivingOf = (server: Server) =>
  Layer.succeed(Receiving, {
    path: "/hooks",
    register: (deliver) =>
      Effect.sync(() => {
        server.deliver = deliver;
        server.registered += 1;

        return { id: "w1", secret };
      }),
  });

const delivery = new Event.WebhookDelivery({ baseUrl: "https://hooks.example.com" });

const occurrence = (id: string, cursor: string) => ({
  eventId: id,
  name: Changed.name,
  timestamp: "2026-10-21T00:00:00.000Z",
  data: { id },
  cursor,
});

const ids = (received: Iterable<Event.Received<Event.Any>>) =>
  Array.from(received, (each) =>
    Predicate.isTagged(each, "Occurrence") ? each.eventId : `gap at ${each.cursor}`,
  );

describe("a watch by webhook", () => {
  it.effect(
    "subscribes its url with its watch's id, and keeps each grant's position behind what was accepted before it",
    () =>
      Effect.gen(function* () {
        const server = makeServer(grant("0", 60_000), grant("5", null));
        const store = yield* KeyValueStore.KeyValueStore;

        yield* Effect.forkScoped(
          watching(transportOf(server), { mode: delivery, resume: { store, key: "k" } }).pipe(
            Stream.runDrain,
            Effect.provide(receivingOf(server)),
          ),
        );

        yield* settled(() => server.requests.length === 1);

        expect(server.deliver(occurrence("c1", "1"))).toBe(true);

        yield* TestClock.adjust("30 seconds");
        yield* settled(() => server.requests.length === 2);
        yield* Effect.yieldNow;

        expect(server.requests.map(({ delivery, cursor }) => [delivery.url.href, cursor])).toEqual([
          ["https://hooks.example.com/hooks?watch=w1", null],
          ["https://hooks.example.com/hooks?watch=w1", "1"],
        ]);
        expect(yield* store.get("k")).toBe("5");
      }).pipe(Effect.scoped, Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect(
    "reads a truncated grant and a gap envelope as gaps, and skips an envelope of a type it does not know",
    () =>
      Effect.gen(function* () {
        const server = makeServer(grant("3", null, true));

        const read = yield* Effect.forkScoped(
          watching(transportOf(server), { mode: delivery }).pipe(
            Stream.take(3),
            Stream.runCollect,
            Effect.provide(receivingOf(server)),
          ),
        );

        yield* settled(() => server.requests.length === 1);

        server.deliver({ type: "renamed", cursor: "4" });
        server.deliver({ type: "gap", cursor: "9" });
        server.deliver(occurrence("c1", "10"));

        expect(ids(yield* Fiber.join(read))).toEqual(["gap at 3", "gap at 9", "c1"]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps what was accepted through a reconnect, registering once and unsubscribing once",
    () =>
      Effect.gen(function* () {
        const server = makeServer(grant("0", 60_000), Effect.fail(new Blip()));

        const read = yield* Effect.forkScoped(
          watching(transportOf(server), { mode: delivery }).pipe(
            Stream.take(2),
            Stream.runCollect,
            Effect.provide(receivingOf(server)),
          ),
        );

        yield* settled(() => server.requests.length === 1);

        server.deliver(occurrence("c1", "1"));

        yield* TestClock.adjust("30 seconds");
        yield* settled(() => server.requests.length === 2);

        const accepted = server.deliver(occurrence("c2", "2"));

        yield* TestClock.adjust("1 second");

        expect(ids(yield* Fiber.join(read))).toEqual(["c1", "c2"]);
        expect(accepted).toBe(true);
        expect(server.registered).toBe(1);
        expect(server.requests.map(({ cursor }) => cursor)).toEqual([null, "1", "1"]);
        expect(server.unsubscribed).toEqual(["https://hooks.example.com/hooks?watch=w1"]);
      }).pipe(Effect.scoped),
  );

  it.effect("fails where it is read with a defect its refresh dies of", () =>
    Effect.gen(function* () {
      const server = makeServer(grant("0", 60_000), Effect.die(new Error("The refresh broke.")));

      const read = yield* Effect.forkScoped(
        watching(transportOf(server), { mode: delivery }).pipe(
          Stream.runDrain,
          Effect.provide(receivingOf(server)),
          Effect.exit,
        ),
      );

      yield* settled(() => server.requests.length === 1);
      yield* TestClock.adjust("30 seconds");

      expect(Exit.hasDies(yield* Fiber.join(read))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a body while 16 wait unread, and reads each one it accepted", () =>
    Effect.gen(function* () {
      const server = makeServer(grant("0", null));
      const gate = yield* Deferred.make<void>();

      const read = yield* Effect.forkScoped(
        watching(transportOf(server), { mode: delivery }).pipe(
          Stream.tap(() => Deferred.await(gate)),
          Stream.take(20),
          Stream.runCollect,
          Effect.provide(receivingOf(server)),
        ),
      );

      yield* settled(() => server.requests.length === 1);

      const sent = Array.from({ length: 20 }, (_, index) => `c${index}`);
      const accepted = sent.filter((id, index) => server.deliver(occurrence(id, String(index))));

      expect(accepted).toEqual(sent.slice(0, 16));

      yield* Deferred.succeed(gate, undefined);

      for (const id of sent.slice(accepted.length)) {
        yield* settled(() => server.deliver(occurrence(id, String(sent.indexOf(id)))));
      }

      expect(ids(yield* Fiber.join(read))).toEqual(sent);
    }).pipe(Effect.scoped),
  );

  it.effect("ends within its bound when the server never answers its unsubscribe", () =>
    Effect.gen(function* () {
      const server = makeServer(grant("0", null));

      server.unsubscribe = Effect.never;

      const read = yield* Effect.forkChild(
        watching(transportOf(server), { mode: delivery }).pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.provide(receivingOf(server)),
        ),
      );

      yield* settled(() => server.requests.length === 1);

      server.deliver(occurrence("c1", "1"));

      yield* TestClock.adjust("5 seconds");

      expect(ids(yield* Fiber.join(read))).toEqual(["c1"]);
      expect(server.unsubscribed).toHaveLength(1);
    }),
  );
});
