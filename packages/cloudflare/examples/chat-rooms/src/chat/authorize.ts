import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { CurrentMember } from "../identity/Identity.js";
import { Room } from "./room.js";

// The one rule: a member reads and writes only the rooms they belong to. It is built as
// handlers are: this Effect runs once per instance and gets the room, a startup service; the
// function it returns runs before every handler and reads the caller of that call.
export const authorize = Effect.gen(function* () {
  const room = yield* Room;

  return Effect.fn("authorize")(function* () {
    const member = yield* CurrentMember;

    if (!member.rooms.includes(room)) {
      return yield* new Action.Forbidden({ message: `Not a member of ${room}.` });
    }
  });
});
