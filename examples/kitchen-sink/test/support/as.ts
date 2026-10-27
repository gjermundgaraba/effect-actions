import { Effect } from "effect";

import { CurrentMember } from "../../src/identity/Identity.js";
import { members } from "../../src/identity/members.js";

// What the implementation does, with no transport: `Action.client` runs the same decoding,
// `authorize` and handler a server runs. Each call or watch names its caller, as a request would.
export const as = (member: keyof typeof members) =>
  Effect.provideService(CurrentMember, members[member]);
