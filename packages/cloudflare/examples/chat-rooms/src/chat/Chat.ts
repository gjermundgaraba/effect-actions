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
  description: "Post a message to the room.",
  input: {
    ...inRoom,
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
    request: Schema.optional(
      Schema.String.annotate({
        description:
          "A random id for this message, sent again on a retry: the room keeps one message per author and request, answering a repeat with it, whatever its text.",
      }).check(Schema.isMaxLength(64))
    ),
  },
  success: Message,
  readOnly: false,
});

export const Messages = [ReadMessages, PostMessage] as const;

export const MessagePosted = Event.make("message.posted", {
  description: "A message posted to the room.",
  input: inRoom,
  payload: Message,
  caller: CurrentMember,
});
