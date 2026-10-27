import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Schema } from "effect";

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
export class MessageNotFound extends Schema.TaggedError<
  MessageNotFound,
  { readonly brand: unique symbol }
>()("MessageNotFound", { id: Schema.Int }, { httpApiStatus: 404 }) {}

// A refusal carries what the caller sent and no more: who wrote the message is for the actions
// that read it, under their own rule.
export class NotAuthor extends Schema.TaggedError<
  NotAuthor,
  { readonly brand: unique symbol }
>()("NotAuthor", { id: Schema.Int }, { httpApiStatus: 403 }) {}

// Which room a call is about is not an input of any action: it travels beside the call, in
// this header, as the token does, because `authorize` sees the action and not its input, and
// the membership rule needs the room. With the room in the input, that check belongs in the
// store, as `MessageStore.remove` takes the author and refuses with `NotAuthor`, never in a
// helper each handler must remember to call. The client sets the header; on the server,
// room.ts reads it. A call without it is about the default room, so `listRooms`, which is
// about none, sends none; yours may refuse such a call instead.
export const roomHeader = "x-room";

export const defaultRoom = "lobby";

// Public: `caller: Action.Anyone`, so a page shows the rooms before anyone has signed in. It
// tells a signed-out caller every room's name and how many messages it holds, a room appearing
// once someone posts: decide whether yours may.
export const ListRooms = Action.make("listRooms", {
  description:
    "List the rooms someone has posted in, and how many messages each holds.",
  success: {
    rooms: Schema.Array(
      Schema.Struct({ name: Schema.String, messages: Schema.Int })
    ),
  },
  readOnly: true,
  caller: Action.Anyone,
});

const signedIn = { caller: CurrentMember } as const;

// Reads once: a page opening a room reads what is there, then watches `MessagePosted` below from
// the last id it read.
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
  input: {
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  },
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

// Each message posted to the room, as it is posted: a page watches it on its open socket,
// about the room its header names, as the actions are. Signed-in, so each watch authenticates
// and runs `authorize` as it starts, refused for a member outside the room.
export const MessagePosted = Event.make("message.posted", {
  description: "A message posted to the room.",
  payload: Message,
  caller: CurrentMember,
});
