import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Effect } from "effect";

import { CurrentMember } from "../identity/Identity.js";
import { Room } from "./room.js";

export const authorize = Effect.gen(function* () {
  const room = yield* Room;

  return Effect.fn("authorize")(function* () {
    const member = yield* CurrentMember;

    if (!member.rooms.includes(room)) {
      return yield* new Action.Forbidden({
        message: `Not a member of ${room}.`,
      });
    }
  });
});
