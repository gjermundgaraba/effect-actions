import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, flow, Stream } from "effect";
import { TestClock } from "effect/testing";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { MessagePosted, NotAuthor } from "../../src/chat/Chat.js";
import { messageEvents } from "../../src/chat/events.js";
import { messages } from "../../src/chat/handlers.js";
import { CurrentRoom } from "../../src/chat/room.js";
import { MessageStore } from "../../src/chat/store.js";
import { CurrentMember } from "../../src/identity/Identity.js";
import { members } from "../../src/identity/members.js";

// What the implementation does, with no transport: `Action.client` runs the same decoding,
// `authorize` and handler a server runs. No authentication and no middleware run here, so
// each call is given what they would provide: its caller and its room. Neither is provided
// around the client or beside the store: a request-time service belongs to one call.
const as = (member: keyof typeof members, room: string) =>
  flow(
    Effect.provideService(CurrentMember, members[member]),
    Effect.provideService(CurrentRoom, room),
  );

describe("messages, in process", () => {
  it.effect("keeps each room's messages its own, numbered from 1", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(messages);

      yield* client.postMessage({ text: "Deploying at noon." }).pipe(as("ada", "lobby"));
      yield* client.postMessage({ text: "Disk is full." }).pipe(as("ada", "ops"));
      yield* client.postMessage({ text: "Ready." }).pipe(as("grace", "lobby"));

      expect(yield* client.readMessages({ after: 1 }).pipe(as("grace", "lobby"))).toEqual({
        messages: [{ id: 2, author: "grace", text: "Ready." }],
      });
      expect(yield* client.readMessages({ after: 0 }).pipe(as("ada", "ops"))).toEqual({
        messages: [{ id: 1, author: "ada", text: "Disk is full." }],
      });
    }).pipe(Effect.provide([MessageStore.layerMemory, Event.layerMemory])),
  );

  it.effect("lets only its author delete a message", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(messages);
      const { id } = yield* client.postMessage({ text: "Oops." }).pipe(as("ada", "lobby"));

      expect(yield* Effect.flip(client.deleteMessage({ id }).pipe(as("grace", "lobby")))).toEqual(
        new NotAuthor({ id }),
      );

      yield* client.deleteMessage({ id }).pipe(as("ada", "lobby"));

      expect(yield* client.readMessages({ after: 0 }).pipe(as("grace", "lobby"))).toEqual({
        messages: [],
      });
    }).pipe(Effect.provide([MessageStore.layerMemory, Event.layerMemory])),
  );

  it.effect("refuses a member a room they have not joined, before the handler runs", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(messages);
      const post = client.postMessage({ text: "Hello?" }).pipe(as("grace", "ops"));
      const refused = yield* Effect.flip(post);

      expect(refused).toBeInstanceOf(Action.Forbidden);
      expect(refused.message).toBe("Not a member of ops.");
      expect(yield* client.readMessages({ after: 0 }).pipe(as("ada", "ops"))).toEqual({
        messages: [],
      });
    }).pipe(Effect.provide([MessageStore.layerMemory, Event.layerMemory])),
  );

  it.effect(
    "delivers each message posted to a watched room as it is posted, and none of another",
    () =>
      Effect.gen(function* () {
        const client = yield* Action.client([messages, messageEvents]);
        const { epoch } = yield* MessageStore;

        const watching = yield* client
          .watch(MessagePosted, {})
          .pipe(Stream.take(1), Stream.runCollect, as("grace", "lobby"), Effect.forkChild);

        // The watch starts from now: let it take its first position before anyone posts.
        yield* TestClock.adjust("0 millis");
        yield* client.postMessage({ text: "Disk is full." }).pipe(as("ada", "ops"));
        yield* client.postMessage({ text: "Ready." }).pipe(as("ada", "lobby"));

        // `postMessage` notifies: the watch reads at once, with no wait for its next read.
        expect(yield* Fiber.join(watching)).toMatchObject([
          {
            _tag: "Occurrence",
            eventId: `${epoch}:lobby:1`,
            data: { id: 1, author: "ada", text: "Ready." },
          },
        ]);
      }).pipe(Effect.provide([MessageStore.layerMemory, Event.layerMemory])),
  );

  it.effect("names the first message after a restart apart from the one before it", () =>
    Effect.gen(function* () {
      const firstReceived = Effect.gen(function* () {
        const client = yield* Action.client([messages, messageEvents]);

        const watching = yield* client
          .watch(MessagePosted, {})
          .pipe(Stream.take(1), Stream.runCollect, as("grace", "lobby"), Effect.forkChild);

        yield* TestClock.adjust("0 millis");
        yield* client.postMessage({ text: "Ready." }).pipe(as("ada", "lobby"));

        return yield* Fiber.join(watching);
      }).pipe(Effect.provide([MessageStore.layerMemory, Event.layerMemory]));

      const received = [...(yield* firstReceived), ...(yield* firstReceived)];

      // Both are the room's message 1, and a watch that saw the first still reads the second.
      expect(received).toMatchObject([{ data: { id: 1 } }, { data: { id: 1 } }]);
      expect(
        new Set(received.map((each) => (each._tag === "Occurrence" ? each.eventId : ""))).size,
      ).toBe(2);
    }),
  );

  it.effect("refuses a watch of a room the member has not joined", () =>
    Effect.gen(function* () {
      const client = yield* Action.client([messages, messageEvents]);

      const refused = yield* Effect.flip(
        Stream.runDrain(client.watch(MessagePosted, {})).pipe(as("grace", "ops")),
      );

      expect(refused).toBeInstanceOf(Action.Forbidden);
    }).pipe(Effect.provide([MessageStore.layerMemory, Event.layerMemory])),
  );

  it.effect("answers a cursor that names no id of the room with a gap, then reads on", () =>
    Effect.gen(function* () {
      const client = yield* Action.client([messages, messageEvents]);
      const { epoch } = yield* MessageStore;

      yield* client.postMessage({ text: "Ready." }).pipe(as("ada", "lobby"));

      // An event's id, such as `<epoch>:lobby:1`, is no cursor: the cursor is `<epoch>:<id>`.
      const received = yield* client
        .watch(MessagePosted, {}, { cursor: "lobby:1" })
        .pipe(Stream.take(1), Stream.runCollect, as("grace", "lobby"));

      expect(received).toMatchObject([{ _tag: "Gap", cursor: `${epoch}:1` }]);
    }).pipe(Effect.provide([MessageStore.layerMemory, Event.layerMemory])),
  );

  it.effect("answers a cursor with more parts than `<epoch>:<id>` with a gap", () =>
    Effect.gen(function* () {
      const client = yield* Action.client([messages, messageEvents]);
      const { epoch } = yield* MessageStore;

      yield* client.postMessage({ text: "Disk is full." }).pipe(as("ada", "lobby"));
      yield* client.postMessage({ text: "Ready." }).pipe(as("ada", "lobby"));

      const received = yield* client
        .watch(MessagePosted, {}, { cursor: `${epoch}:1:lobby` })
        .pipe(Stream.take(1), Stream.runCollect, as("grace", "lobby"));

      expect(received).toMatchObject([{ _tag: "Gap", cursor: `${epoch}:2` }]);
    }).pipe(Effect.provide([MessageStore.layerMemory, Event.layerMemory])),
  );

  it.effect(
    "answers a cursor from before a restart with a gap, however far the store has counted",
    () =>
      Effect.gen(function* () {
        const posted = (text: string) =>
          Effect.flatMap(Action.client([messages, messageEvents]), (client) =>
            client.postMessage({ text }).pipe(as("ada", "lobby")),
          );

        const watchedFrom = (cursor: string) =>
          Effect.flatMap(Action.client([messages, messageEvents]), (client) =>
            client
              .watch(MessagePosted, {}, { cursor })
              .pipe(Stream.take(1), Stream.runCollect, as("grace", "lobby")),
          );

        const run = Effect.provide([MessageStore.layerMemory, Event.layerMemory]);

        const [before] = yield* Effect.andThen(
          posted("Before the restart."),
          watchedFrom("0"),
        ).pipe(run);

        const after = yield* Effect.andThen(
          posted("After the restart."),
          watchedFrom(before?._tag === "Occurrence" ? (before.cursor ?? "") : ""),
        ).pipe(run);

        expect(before).toMatchObject({ _tag: "Occurrence", data: { id: 1 } });
        expect(after).toMatchObject([{ _tag: "Gap" }]);
      }),
  );
});
