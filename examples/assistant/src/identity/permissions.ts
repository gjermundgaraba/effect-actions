import { Context, Effect, Layer } from "effect";

export type Permission = "tasks:read" | "tasks:write";

export class Permissions extends Context.Service<
  Permissions,
  {
    readonly granted: (
      memberId: string
    ) => Effect.Effect<readonly Permission[]>;
  }
>()("assistant/Permissions") {
  static readonly layerMemory = Layer.sync(Permissions, () => {
    const table = new Map<string, readonly Permission[]>([
      ["ada", ["tasks:read", "tasks:write"]],
      ["grace", ["tasks:read", "tasks:write"]],
      ["guest", ["tasks:read"]],
    ]);

    return Permissions.of({
      granted: (memberId) => Effect.sync(() => table.get(memberId) ?? []),
    });
  });
}
