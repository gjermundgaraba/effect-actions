import { Effect } from "effect";
import { authorize, CurrentActor } from "./auth.js";
import { Actions } from "./contracts.js";
import { Users } from "./users.js";

// Capture Users at startup; resolve CurrentActor per request.
export const App = Actions.implement(
  Effect.gen(function* () {
    const users = yield* Users;

    return {
      getUser: ({ id }) =>
        Effect.gen(function* () {
          const actor = yield* authorize("users:read");

          return yield* users.get(actor.tenantId, id);
        }),
      renameUser: ({ id, name }) =>
        Effect.gen(function* () {
          const actor = yield* authorize("users:write");

          return yield* users.rename(actor.tenantId, id, name);
        }),
      double: ({ value }) => Effect.succeed(value * 2),
      whoAmI: () => Effect.map(CurrentActor, ({ id, tenantId }) => ({ id, tenantId })),
    };
  }),
);
