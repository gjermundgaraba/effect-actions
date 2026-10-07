import { Context, Effect } from "effect";
import * as Action from "../src/Action.js";

export type Permission = "users:read" | "users:write";

export interface Actor {
  readonly id: string;
  readonly tenantId: string;
  readonly permissions: ReadonlyArray<Permission>;
}

/** DEMO ONLY: fixed credentials, not OAuth or a production token verifier. */
export const actors = {
  alice: { id: "alice", tenantId: "acme", permissions: ["users:read", "users:write"] },
  reader: { id: "reader", tenantId: "acme", permissions: ["users:read"] },
  bob: { id: "bob", tenantId: "other", permissions: ["users:read", "users:write"] },
} as const satisfies Readonly<Record<string, Actor>>;

/**
 * The identity a protected contract declares, `caller: CurrentActor`: provided per request by
 * authentication, and by the host on a local surface.
 */
export class CurrentActor extends Context.Service<CurrentActor, Actor>()("example/CurrentActor") {}

/**
 * One authorization rule for every surface, derived from each contract's own `readOnly`. An
 * implementation of protected actions states it, `{ authorize }`, so every surface serving
 * them runs it before each handler, once the caller is authenticated, and no handler contains
 * authorization code. Its `Forbidden` is built in: every endpoint and tool declares it, and
 * every client decodes it. Naming the missing scope makes it the `insufficient_scope`
 * challenge an OAuth client steps up on.
 */
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
