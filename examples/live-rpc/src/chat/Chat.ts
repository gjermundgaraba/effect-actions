import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Schema } from "effect";

import { CurrentMember } from "../identity/Identity.js";

export const Message = Schema.Struct({
  id: Schema.Int,
  author: Schema.String,
  text: Schema.String,
});

export type Message = typeof Message.Type;

export class MessageNotFound extends Schema.TaggedError<
  MessageNotFound,
  { readonly brand: unique symbol }
>()("MessageNotFound", { id: Schema.Int }, { httpApiStatus: 404 }) {}

export class NotAuthor extends Schema.TaggedError<
  NotAuthor,
  { readonly brand: unique symbol }
>()("NotAuthor", { id: Schema.Int }, { httpApiStatus: 403 }) {}

export const roomHeader = "x-room";

export const defaultRoom = "lobby";

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

export const MessagePosted = Event.make("message.posted", {
  description: "A message posted to the room.",
  payload: Message,
  caller: CurrentMember,
});
