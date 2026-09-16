import { Context, Effect, Schema } from "effect";

export type Permission = "users:read" | "users:write";

export interface Actor {
  readonly id: string;
  readonly tenantId: string;
  readonly permissions: ReadonlyArray<Permission>;
}

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

export const authorize = Effect.fn("authorize")(function* (permission: Permission) {
  const actor = yield* CurrentActor;
  if (!actor.permissions.includes(permission)) return yield* new Forbidden({ permission });
  return actor;
});
