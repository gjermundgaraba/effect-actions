import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Schema } from "effect";

import { DemoRoomName } from "../chat/Chat.js";

export const RoomPreview = Schema.Struct({
  room: DemoRoomName,
  latestAt: Schema.NullOr(Schema.Int),
});

export type RoomPreview = typeof RoomPreview.Type;

export const Previews = Action.make("previews", {
  description:
    "When each room was last active, in milliseconds, if it holds any message.",
  success: { previews: Schema.Array(RoomPreview) },
  readOnly: true,
  caller: Action.Anyone,
});

export const PreviewsChanged = Event.make("previews.changed", {
  description:
    "When each room was last active, sent whole: first as it is, then on each change.",
  payload: Schema.Struct({ previews: Schema.Array(RoomPreview) }),
  caller: Action.Anyone,
});
