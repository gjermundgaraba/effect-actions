import { Effect } from "effect";
import * as Action from "../src/Action.js";
import { authorize, CurrentActor } from "./authorization.js";
import { Double, GetUser, ListChanges, RenameUser, Status, WhoAmI } from "./contracts.js";
import { Users } from "./users.js";

// Every caller may call, and it owes nothing per request: public wherever no
// authentication covers it.
export const status = Action.implement(
  Status,
  Effect.gen(function* () {
    const users = yield* Users;

    return () => Effect.map(users.count, (count) => ({ service: "effect-actions", users: count }));
  }),
  Action.allowAll,
);

// Capture Users at startup; resolve CurrentActor per request. Every surface runs the
// `authorize` hook before each handler, so it has already refused an actor without the
// permission the action's access needs.
export const userActions = Action.implement(
  [GetUser, RenameUser, WhoAmI],
  Effect.gen(function* () {
    const users = yield* Users;

    return {
      getUser: ({ id }) => Effect.flatMap(CurrentActor, (actor) => users.get(actor.tenantId, id)),
      renameUser: ({ id, name }) =>
        Effect.flatMap(CurrentActor, (actor) => users.rename(actor, id, name)),
      whoAmI: () => Effect.map(CurrentActor, ({ id, tenantId }) => ({ id, tenantId })),
    };
  }),
  authorize,
);

// Pure: no builder and no services, only the hook.
export const double = Action.implement(Double, ({ value }) => Effect.succeed(value * 2), authorize);

export const listChanges = Action.implement(
  ListChanges,
  Effect.gen(function* () {
    const users = yield* Users;

    return () =>
      Effect.gen(function* () {
        const actor = yield* CurrentActor;

        return { changes: yield* users.changes(actor.tenantId) };
      });
  }),
  authorize,
);
