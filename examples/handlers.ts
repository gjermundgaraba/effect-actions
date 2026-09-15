import { Effect } from "effect";
import { authorize, CurrentActor } from "./auth.js";
import { Actions } from "./contracts.js";
import { Users } from "./users.js";

// Implement every action once; input, success, and error types come from the
// contracts. Services yielded here (Users) are resolved once when the Layer is
// built. Services yielded inside a handler (CurrentActor, via authorize) are
// request-scoped and must be provided by the host per request.
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
      // Schema decoding has already converted the string input to a number.
      double: ({ value }) => Effect.succeed(value * 2),
      whoAmI: () => Effect.map(CurrentActor, ({ id, tenantId }) => ({ id, tenantId })),
    };
  }),
);
