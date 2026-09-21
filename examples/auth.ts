import { Context, Effect, Schema } from "effect";
import type * as Action from "../src/Action.js";

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

/** Provided per request by the host's authentication middleware. */
export class CurrentActor extends Context.Service<CurrentActor, Actor>()("example/CurrentActor") {}

export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()(
  "Unauthenticated",
  { message: Schema.String },
  { httpApiStatus: 401 },
) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  { permission: Schema.String },
  { httpApiStatus: 403 },
) {}

/**
 * One authorization rule for every guarded surface, derived from each contract's
 * own `access`. Each adapter binds it as its `before` hook, so it runs before
 * every handler and no handler contains authorization code.
 */
export const authorize = Effect.fn("authorize")(function* (action: Action.Any) {
  const permission: Permission = action.access === "read" ? "users:read" : "users:write";
  const actor = yield* CurrentActor;

  if (!actor.permissions.includes(permission)) return yield* new Forbidden({ permission });
});
