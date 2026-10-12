import { Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { CurrentMember } from "../identity/Identity.js";

// A message's `id` counts up within its room, so a client asks for what came after the last
// one it holds.
export const Message = Schema.Struct({
  id: Schema.Int,
  author: Schema.String,
  text: Schema.String,
});

export type Message = typeof Message.Type;

// A declared error is part of the contract: every client decodes it as this class. Its status
// is for a JSON binding, should these actions be served as one too: an rpc carries no status,
// and an error without one answers 422 over HTTP.
export class MessageNotFound extends Schema.TaggedError<MessageNotFound>()(
  "MessageNotFound",
  { id: Schema.Int },
  { httpApiStatus: 404 },
) {}

export class NotAuthor extends Schema.TaggedError<NotAuthor>()(
  "NotAuthor",
  { id: Schema.Int, author: Schema.String },
  { httpApiStatus: 403 },
) {}

// Which room a call is about is not an input of any action: it travels beside the call, in
// this header, as the token does. The client sets it; on the server, room.ts reads it. A call
// without the header is about the default room, so `listRooms`, which is about none, sends none.
export const roomHeader = "x-room";

export const defaultRoom = "lobby";

// Public: `caller: Action.Anyone`. A page shows the rooms before anyone has signed in.
export const ListRooms = Action.make("listRooms", {
  description: "List the rooms someone has posted in, and how many messages each holds.",
  success: {
    rooms: Schema.Array(Schema.Struct({ name: Schema.String, messages: Schema.Int })),
  },
  readOnly: true,
  caller: Action.Anyone,
});

const signedIn = { caller: CurrentMember } as const;

// Actions are unary: nothing streams. A page keeps up by calling this again on its open
// socket, passing the last id it has seen.
export const ReadMessages = Action.make("readMessages", {
  ...signedIn,
  description: "Read the room's messages after the given id; 0 reads them all.",
  input: { after: Schema.Int },
  success: { messages: Schema.Array(Message) },
  readOnly: true,
});

export const PostMessage = Action.make("postMessage", {
  ...signedIn,
  description: "Post a message to the room.",
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

export const Messages = [ReadMessages, PostMessage, DeleteMessage] as const;
