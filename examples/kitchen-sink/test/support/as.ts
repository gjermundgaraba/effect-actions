import { Effect } from "effect";

import { CurrentMember } from "../../src/identity/Identity.js";
import { demoMembers } from "../../src/identity/members.js";

export const as = (member: keyof typeof demoMembers) =>
  Effect.provideService(CurrentMember, demoMembers[member]);
