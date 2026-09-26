import { Effect } from "effect";
import * as Action from "../src/Action.js";
import { authenticate } from "./authentication.js";
import { authorize, CurrentActor } from "./authorization.js";
import { Double, GetUser, ListChanges, RenameUser, Status, WhoAmI } from "./contracts.js";
import { Users } from "./users.js";

// Who may call, for every surface that serves an implementation: HTTP surfaces run
// `authenticate`, and every surface runs `authorize` before each handler.
const guarded = { authenticate, before: authorize };

// No policy and no request requirement: public on every surface.
export const status = Action.implement(
  Status,
  Effect.gen(function* () {
    const users = yield* Users;

    return () => Effect.map(users.count, (count) => ({ service: "effect-actions", users: count }));
  }),
);

// Capture Users at startup; resolve CurrentActor per request. The hook has already
// refused an actor without the permission the action's access needs.
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
  guarded,
);

// Pure: no builder and no services, only the policy.
export const double = Action.implement(Double, ({ value }) => Effect.succeed(value * 2), guarded);

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
  guarded,
);
