import { describe, expect, it } from "@effect/vitest";
import { Effect, flow } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Feed from "@gjermundgaraba/effect-actions/Feed";
import { NotAuthor } from "../../src/chat/Chat.js";
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
    }).pipe(Effect.provide([MessageStore.layerMemory, Feed.layer])),
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
    }).pipe(Effect.provide([MessageStore.layerMemory, Feed.layer])),
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
    }).pipe(Effect.provide([MessageStore.layerMemory, Feed.layer])),
  );
});
