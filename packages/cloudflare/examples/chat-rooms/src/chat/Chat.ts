import { Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
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

// Every call and watch of a room names it in its input: the Worker sends each on to the room's
// object, and the object refuses an input naming another room, so a page's socket to one room
// cannot reach another. Its schema is the room names, so an unknown room is `InvalidInput`
// before any object is reached.
const inRoom = { room: RoomName };

// Public: the lobby shows anyone, signed in or not, when each room was last active. What was
// said stays with the room's members.
export const Preview = Action.make("preview", {
  description: "When the room's latest message was posted, in milliseconds, if it holds any.",
  input: inRoom,
  success: { latestAt: Schema.NullOr(Schema.Int) },
  readOnly: true,
  caller: Action.Anyone,
});

const signedIn = { caller: CurrentMember } as const;

// Reads once: a page opening a room reads what is there, then watches `MessagePosted` below from
// the last id it read.
export const ReadMessages = Action.make("readMessages", {
  ...signedIn,
  description: "Read the room's messages after the given id; 0 reads them all.",
  input: { ...inRoom, after: Schema.Int },
  success: { messages: Schema.Array(Message) },
  readOnly: true,
});

// `request` is the post's idempotency key: a page makes one at random for each message and
// sends it again when it retries the post, and the room answers the repeat as it answered the
// first, posting once. A model reads its description beside the tool, so it does the same.
export const PostMessage = Action.make("postMessage", {
  ...signedIn,
  description: "Post a message to the room. It expires a day later.",
  input: {
    ...inRoom,
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
    request: Schema.optional(
      Schema.String.annotate({
        description: "A random id for this message, sent again on a retry: it is posted once.",
      }).check(Schema.isMaxLength(64)),
    ),
  },
  success: Message,
  readOnly: false,
  idempotencyKey: "request",
});

export const DeleteMessage = Action.make("deleteMessage", {
  ...signedIn,
  description: "Delete one of your own messages from the room.",
  input: { ...inRoom, id: Schema.Int },
  error: [MessageNotFound, NotAuthor],
  readOnly: false,
});

export const Messages = [ReadMessages, PostMessage, DeleteMessage] as const;

// Each message posted to the room, as it is posted: a page watches it on the socket it keeps
// open to the room's object. Signed-in, so each watch authenticates and runs `authorize` as it
// starts, and again each time the object wakes after hibernating, refused for a member outside
// the room, or one whose token has expired meanwhile.
export const MessagePosted = Event.make("message.posted", {
  description: "A message posted to the room.",
  input: inRoom,
  payload: Message,
  caller: CurrentMember,
});
