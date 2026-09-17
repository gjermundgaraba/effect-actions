import { Context, Effect, Layer } from "effect";
import { type Change, UserNotFound, type User } from "./contracts.js";

interface UsersService {
  readonly get: (tenantId: string, id: string) => Effect.Effect<typeof User.Type, UserNotFound>;

  readonly rename: (
    actor: { readonly id: string; readonly tenantId: string },
    id: string,
    name: string,
  ) => Effect.Effect<typeof User.Type, UserNotFound>;

  readonly count: Effect.Effect<number>;

  readonly changes: (tenantId: string) => Effect.Effect<ReadonlyArray<typeof Change.Type>>;
}

/** Domain service: tenant isolation lives here, not in HTTP or MCP handlers. */
export class Users extends Context.Service<Users, UsersService>()("example/Users") {
  /** Fresh state per runtime. This demo implementation does not persist data. */
  static readonly layerMemory = Layer.sync(Users, () => {
    const users = new Map([
      ["acme/1", { id: "1", name: "Ada" }],
      ["other/1", { id: "1", name: "Grace" }],
    ]);

    const get = Effect.fn("Users.get")(function* (tenantId: string, id: string) {
      const user = users.get(`${tenantId}/${id}`);

      if (user === undefined) {
        return yield* new UserNotFound({ id });
      }

      return user;
    });

    const changes = new Map<string, Array<typeof Change.Type>>();

    const rename = Effect.fn("Users.rename")(function* (
      actor: { readonly id: string; readonly tenantId: string },
      id: string,
      name: string,
    ) {
      yield* get(actor.tenantId, id);
      const user = { id, name };
      users.set(`${actor.tenantId}/${id}`, user);
      changes.set(actor.tenantId, [
        ...(changes.get(actor.tenantId) ?? []),
        { actorId: actor.id, userId: id, name },
      ]);

      return user;
    });

    return Users.of({
      get,
      rename,
      count: Effect.sync(() => users.size),
      changes: (tenantId) => Effect.sync(() => changes.get(tenantId) ?? []),
    });
  });
}
