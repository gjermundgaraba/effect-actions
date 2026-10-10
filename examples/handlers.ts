import { Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { authorize, CurrentActor } from "./authorization.js";
import { Double, GetUser, ListChanges, RenameUser, Status, WhoAmI } from "./contracts.js";
import { Users } from "./users.js";

// A public contract: no authorization runs, and it owes nothing per request, on every
// surface.
export const status = Action.implement(
  Status,
  Effect.gen(function* () {
    const users = yield* Users;

    return () => Effect.map(users.count, (count) => ({ service: "effect-actions", users: count }));
  }),
);

// Capture Users at startup; resolve CurrentActor per request. Every surface authenticates
// the caller, then runs `authorize` before each handler, so it has already refused an actor
// without the permission the action needs. HTTP serves only the actions its binding holds:
// `listChanges`, which it leaves out, is a tool and a command, never a route.
export const userActions = Action.implement(
  [GetUser, RenameUser, WhoAmI, ListChanges],
  Effect.gen(function* () {
    const users = yield* Users;

    return {
      getUser: ({ id }) => Effect.flatMap(CurrentActor, (actor) => users.get(actor.tenantId, id)),
      renameUser: ({ id, name }) =>
        Effect.flatMap(CurrentActor, (actor) => users.rename(actor, id, name)),
      whoAmI: () => Effect.map(CurrentActor, ({ id, tenantId }) => ({ id, tenantId })),
      listChanges: () =>
        Effect.gen(function* () {
          const actor = yield* CurrentActor;

          return { changes: yield* users.changes(actor.tenantId) };
        }),
    };
  }),
  { authorize },
);

// Pure: no builder and no services, only the authorization.
export const double = Action.implement(Double, ({ value }) => Effect.succeed(value * 2), {
  authorize,
});
