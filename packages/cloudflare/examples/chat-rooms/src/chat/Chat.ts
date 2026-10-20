import { Schema } from "effect";
import { Rpc } from "effect/rpc";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { CurrentMember } from "../identity/Identity.js";

// DEMO ONLY: the rooms, fixed. Each name is one Durable Object, which the Worker reaches only
// for a name listed here, so no caller creates an object of its own. A real application keeps
// its rooms in a store and checks a name there before it reaches `getByName`.
export const RoomName = Schema.Literals(["general", "design"]);

export type RoomName = typeof RoomName.Type;

// A message's `id` counts up within its room, so a client asks for what came after the last
// one it holds. `at` is when it was posted, in milliseconds: messages expire a day later.
export const Message = Schema.Struct({
  id: Schema.Int,
  author: Schema.String,
  text: Schema.String,
  at: Schema.Int,
});

export type Message = typeof Message.Type;

// A declared error is part of the contract: every client decodes it as this class. Its status is
// for the JSON routes; an rpc carries none.
export class MessageNotFound extends Schema.TaggedError<MessageNotFound>()(
  "MessageNotFound",
  { id: Schema.Int },
  { httpApiStatus: 404 },
) {}

export class NotAuthor extends Schema.TaggedError<NotAuthor>()(
  "NotAuthor",
  { id: Schema.Int },
  { httpApiStatus: 403 },
) {}

// Public: the lobby shows anyone, signed in or not, when each room was last active. What was
// said stays with the room's members.
export const Preview = Action.make("preview", {
  description: "When the room's latest message was posted, in milliseconds, if it holds any.",
  success: { latestAt: Schema.NullOr(Schema.Int) },
  readOnly: true,
  caller: Action.Anyone,
});

const signedIn = { caller: CurrentMember } as const;

export const PostMessage = Action.make("postMessage", {
  ...signedIn,
  description: "Post a message to the room. It expires a day later.",
  input: { text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)) },
  success: Message,
  readOnly: false,
});

export const DeleteMessage = Action.make("deleteMessage", {
  ...signedIn,
  description: "Delete one of your own messages from the room.",
  input: { id: Schema.Int },
  error: [MessageNotFound, NotAuthor],
  readOnly: false,
});

export const Messages = [PostMessage, DeleteMessage] as const;

// A page follows the room on its open socket: `watch` sends what came after the last message it
// holds, then each message as it is posted, after the object hibernated too. A native Effect
// rpc that streams, beside the actions on the room's binding: authenticated as they are, and
// refused for a member outside the room.
export const Watch = Rpc.make("watch", {
  payload: { after: Schema.Int },
  success: Message,
  error: Action.Forbidden,
  stream: true,
});
