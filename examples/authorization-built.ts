import { Context, Effect, Layer } from "effect";
import * as Action from "../src/Action.js";
import { actors, CurrentActor, type Permission } from "./authorization.js";
import { WhoAmI } from "./contracts.js";

/** DEMO ONLY: each actor's permissions, kept in a store rather than in the identity. */
export class Permissions extends Context.Service<
  Permissions,
  { readonly of: (actorId: string) => Effect.Effect<ReadonlyArray<Permission>> }
>()("example/Permissions") {
  static readonly layerMemory = Layer.succeed(Permissions, {
    of: (actorId) =>
      Effect.succeed(Object.values(actors).find(({ id }) => id === actorId)?.permissions ?? []),
  });
}

// The `authorize` rule, built as handlers are: the store is yielded once, a startup service
// provided next to `Users`, and the hook it returns yields the actor on every call.
export const authorizeStored = Effect.gen(function* () {
  const permissions = yield* Permissions;

  return (action: Action.Any) =>
    Effect.gen(function* () {
      const permission: Permission = action.access === "read" ? "users:read" : "users:write";
      const actor = yield* CurrentActor;

      if (!(yield* permissions.of(actor.id)).includes(permission)) {
        return yield* new Action.Forbidden({
          message: `Requires ${permission}.`,
          scopes: [permission],
        });
      }
    });
});

// Built once per layer graph for this implementation, and per invocation of a local command.
export const whoAmI = Action.implement(
  WhoAmI,
  () => Effect.map(CurrentActor, ({ id, tenantId }) => ({ id, tenantId })),
  authorizeStored,
);
