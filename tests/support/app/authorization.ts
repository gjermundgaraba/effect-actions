import { Context, Effect } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";

export type Permission = "users:read" | "users:write";

export interface Actor {
  readonly id: string;
  readonly tenantId: string;
  readonly permissions: ReadonlyArray<Permission>;
}

export const actors = {
  alice: { id: "alice", tenantId: "acme", permissions: ["users:read", "users:write"] },
  reader: { id: "reader", tenantId: "acme", permissions: ["users:read"] },
  bob: { id: "bob", tenantId: "other", permissions: ["users:read", "users:write"] },
} as const satisfies Readonly<Record<string, Actor>>;

export class CurrentActor extends Context.Service<CurrentActor, Actor>()("example/CurrentActor") {}

export const authorize = Effect.fn("authorize")(function* (action: Action.Any) {
  const permission: Permission = action.readOnly ? "users:read" : "users:write";
  const actor = yield* CurrentActor;

  if (!actor.permissions.includes(permission)) {
    return yield* new Action.Forbidden({
      message: `Requires ${permission}.`,
      scopes: [permission],
    });
  }
});
