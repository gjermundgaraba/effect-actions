import { Effect } from "effect";

import { CurrentMember } from "../../src/identity/Identity.js";
import { members } from "../../src/identity/members.js";

// The caller of one call or subscription, as a server provides it per request.
export const as = (member: keyof typeof members) =>
  Effect.provideService(CurrentMember, members[member]);
