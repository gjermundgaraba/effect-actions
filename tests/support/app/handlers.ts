import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Effect } from "effect";

import { authorize, CurrentActor } from "./authorization.js";
import {
  Double,
  GetUser,
  ListChanges,
  RenameUser,
  Status,
  WhoAmI,
} from "./contracts.js";
import { Users } from "./users.js";

export const status = Action.implement(
  Status,
  Effect.gen(function* () {
    const users = yield* Users;

    return () =>
      Effect.map(users.count, (count) => ({
        service: "effect-actions",
        users: count,
      }));
  })
);

export const userActions = Action.implement(
  [GetUser, RenameUser, WhoAmI, ListChanges],
  Effect.gen(function* () {
    const users = yield* Users;

    return {
      getUser: ({ id }) =>
        Effect.flatMap(CurrentActor, (actor) => users.get(actor.tenantId, id)),
      renameUser: ({ id, name }) =>
        Effect.flatMap(CurrentActor, (actor) => users.rename(actor, id, name)),
      whoAmI: () =>
        Effect.map(CurrentActor, ({ id, tenantId }) => ({ id, tenantId })),
      listChanges: () =>
        Effect.gen(function* () {
          const actor = yield* CurrentActor;

          return { changes: yield* users.changes(actor.tenantId) };
        }),
    };
  }),
  { authorize }
);

export const double = Action.implement(
  Double,
  ({ value }) => Effect.succeed(value * 2),
  {
    authorize,
  }
);
