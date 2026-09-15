import { Context, Effect, Layer } from "effect";
import { UserNotFound, type User } from "./contracts.js";

interface UsersService {
  readonly get: (tenantId: string, id: string) => Effect.Effect<typeof User.Type, UserNotFound>;

  readonly rename: (
    tenantId: string,
    id: string,
    name: string,
  ) => Effect.Effect<typeof User.Type, UserNotFound>;
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

    const rename = Effect.fn("Users.rename")(function* (
      tenantId: string,
      id: string,
      name: string,
    ) {
      yield* get(tenantId, id);
      const user = { id, name };
      users.set(`${tenantId}/${id}`, user);
      return user;
    });

    return Users.of({ get, rename });
  });
}
