import { Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { RoomName } from "../chat/Chat.js";

// When one room was last active, in milliseconds, or null while it holds no message.
export const RoomPreview = Schema.Struct({ room: RoomName, latestAt: Schema.NullOr(Schema.Int) });

export type RoomPreview = typeof RoomPreview.Type;

// The Worker's own action, served by the Worker, not by an object: it asks the lobby's object,
// which keeps every room's preview.
export const Previews = Action.make("previews", {
  description: "When each room was last active, in milliseconds, if it holds any message.",
  success: { previews: Schema.Array(RoomPreview) },
  readOnly: true,
  caller: Action.Anyone,
});

// Every room's preview, sent whole each time one changes: a page watches it on its socket to the
// lobby's object. Public, as `previews` is, so a page signed out follows it too.
export const PreviewsChanged = Event.make("previews.changed", {
  description: "When each room was last active, sent whole: first as it is, then on each change.",
  payload: Schema.Struct({ previews: Schema.Array(RoomPreview) }),
  caller: Action.Anyone,
});
