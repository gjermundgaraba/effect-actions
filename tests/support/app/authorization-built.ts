import { Context, Effect, Layer } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { actors, CurrentActor, type Permission } from "./authorization.js";
import { WhoAmI } from "./contracts.js";

export class Permissions extends Context.Service<
  Permissions,
  { readonly of: (actorId: string) => Effect.Effect<ReadonlyArray<Permission>> }
>()("example/Permissions") {
  static readonly layerMemory = Layer.succeed(Permissions, {
    of: (actorId) =>
      Effect.succeed(Object.values(actors).find(({ id }) => id === actorId)?.permissions ?? []),
  });
}

export const authorizeStored = Effect.gen(function* () {
  const permissions = yield* Permissions;

  return (action: Action.Any) =>
    Effect.gen(function* () {
      const permission: Permission = action.readOnly ? "users:read" : "users:write";
      const actor = yield* CurrentActor;

      if (!(yield* permissions.of(actor.id)).includes(permission)) {
        return yield* new Action.Forbidden({
          message: `Requires ${permission}.`,
          scopes: [permission],
        });
      }
    });
});

export const whoAmI = Action.implement(
  WhoAmI,
  () => Effect.map(CurrentActor, ({ id, tenantId }) => ({ id, tenantId })),
  { authorize: authorizeStored },
);
