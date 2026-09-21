import { Effect } from "effect";
import { CurrentActor } from "./auth.js";
import { AuditActions, PublicActions, UserActions } from "./contracts.js";
import { Users } from "./users.js";

// No request requirement at all, so this group can be mounted without authentication.
export const PublicApp = PublicActions.implement(
  Effect.gen(function* () {
    const users = yield* Users;

    return {
      status: () =>
        Effect.map(users.count, (count) => ({ service: "effect-actions", users: count })),
    };
  }),
);

// Capture Users at startup; resolve CurrentActor per request. Each surface binds
// the `before` hook, which has already refused an actor without the permission
// the action's access needs.
export const UserApp = UserActions.implement(
  Effect.gen(function* () {
    const users = yield* Users;

    return {
      getUser: ({ id }) => Effect.flatMap(CurrentActor, (actor) => users.get(actor.tenantId, id)),
      renameUser: ({ id, name }) =>
        Effect.flatMap(CurrentActor, (actor) => users.rename(actor, id, name)),
      double: ({ value }) => Effect.succeed(value * 2),
      whoAmI: () => Effect.map(CurrentActor, ({ id, tenantId }) => ({ id, tenantId })),
    };
  }),
);

export const AuditApp = AuditActions.implement(
  Effect.gen(function* () {
    const users = yield* Users;

    return {
      listChanges: () =>
        Effect.gen(function* () {
          const actor = yield* CurrentActor;

          return { changes: yield* users.changes(actor.tenantId) };
        }),
    };
  }),
);
