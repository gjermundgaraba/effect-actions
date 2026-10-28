import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Effect } from "effect";

import { CurrentMember } from "../identity/Identity.js";
import { CurrentRoom } from "./room.js";

export const authorize = Effect.fn("authorize")(function* () {
  const member = yield* CurrentMember;
  const room = yield* CurrentRoom;

  if (!member.rooms.includes(room)) {
    return yield* new Action.Forbidden({ message: `Not a member of ${room}.` });
  }
});
