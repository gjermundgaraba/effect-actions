import { Effect } from "effect";

import { CurrentUser } from "../../src/identity/Identity.js";
import { demoUsers } from "../../src/identity/users.js";

export const as = (user: keyof typeof demoUsers) =>
  Effect.provideService(CurrentUser, demoUsers[user]);
