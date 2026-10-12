import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { CurrentMember } from "../identity/Identity.js";
import { CurrentRoom } from "./room.js";

// The one rule: a member reads and writes only the rooms they belong to. It runs before every
// protected handler, on every surface, and reads two request-time services: the caller, from
// authentication, and the room, from the middleware.
export const authorize = Effect.fn("authorize")(function* () {
  const member = yield* CurrentMember;
  const room = yield* CurrentRoom;

  if (!member.rooms.includes(room)) {
    return yield* new Action.Forbidden({ message: `Not a member of ${room}.` });
  }
});
