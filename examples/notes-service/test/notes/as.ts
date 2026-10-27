import { Effect } from "effect";

import { CurrentUser } from "../../src/identity/Identity.js";
import { users } from "../../src/identity/users.js";

// The caller of one call, as a server provides it per request.
export const as = (user: keyof typeof users) =>
  Effect.provideService(CurrentUser, users[user]);
