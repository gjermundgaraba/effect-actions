import { Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Message } from "../chat/Chat.js";

// A room's name, as the Worker routes it to the room's object: also what keeps an arbitrary
// string from naming an object.
export const RoomName = Schema.String.check(Schema.isPattern(/^[a-z0-9-]{1,32}$/u));

// The Worker's own action, served by the Worker, not by a room: it asks each room's object.
export const Previews = Action.make("previews", {
  description: "Each named room's latest message, if it holds any.",
  input: { rooms: Schema.Array(RoomName).check(Schema.isMaxLength(10)) },
  success: {
    previews: Schema.Array(Schema.Struct({ room: Schema.String, latest: Schema.NullOr(Message) })),
  },
  readOnly: true,
  caller: Action.Anyone,
});
