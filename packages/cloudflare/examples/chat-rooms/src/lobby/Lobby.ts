import { Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { RoomName } from "../chat/Chat.js";

// The Worker's own action, served by the Worker, not by a room: it asks each room's object.
export const Previews = Action.make("previews", {
  description: "When each room was last active, in milliseconds, if it holds any message.",
  success: {
    previews: Schema.Array(Schema.Struct({ room: RoomName, latestAt: Schema.NullOr(Schema.Int) })),
  },
  readOnly: true,
  caller: Action.Anyone,
});
