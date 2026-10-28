import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Schema } from "effect";

import { CurrentMember } from "../identity/Identity.js";

export const DemoRoomName = Schema.Literals(["general", "design"]);

export type DemoRoomName = typeof DemoRoomName.Type;

export const Message = Schema.Struct({
  id: Schema.Int,
  author: Schema.String,
  text: Schema.String,
  at: Schema.Int,
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

const inRoom = { room: DemoRoomName };

const signedIn = { caller: CurrentMember } as const;

export const ReadMessages = Action.make("readMessages", {
  ...signedIn,
  description: "Read the room's messages after the given id; 0 reads them all.",
  input: { ...inRoom, after: Schema.Int },
  success: { messages: Schema.Array(Message) },
  readOnly: true,
});

export const PostMessage = Action.make("postMessage", {
  ...signedIn,
  description: "Post a message to the room. It expires a day later.",
  input: {
    ...inRoom,
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
    request: Schema.optional(
      Schema.String.annotate({
        description:
          "A random id for this message, sent again on a retry: it is posted once.",
      }).check(Schema.isMaxLength(64))
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

export const MessagePosted = Event.make("message.posted", {
  description: "A message posted to the room.",
  input: inRoom,
  payload: Message,
  caller: CurrentMember,
});
