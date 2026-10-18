import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { CurrentMember } from "../identity/Identity.js";

// The one rule: a member reads and writes only the rooms they belong to. The caller is each
// message's, read per call; the room is the object's own, known when the instance builds its
// routes, so the rule is made for that room then, never read per call.
export const authorizeIn = (room: string) =>
  Effect.fn("authorize")(function* () {
    const member = yield* CurrentMember;

    if (!member.rooms.includes(room)) {
      return yield* new Action.Forbidden({ message: `Not a member of ${room}.` });
    }
  });
