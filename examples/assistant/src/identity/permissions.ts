import { Context, Effect, Layer } from "effect";

export type Permission = "tasks:read" | "tasks:write";

/**
 * What each member may do. Permissions are kept here, not in the identity, so changing one
 * takes effect on the member's next call.
 */
export class Permissions extends Context.Service<
  Permissions,
  { readonly granted: (memberId: string) => Effect.Effect<ReadonlyArray<Permission>> }
>()("assistant/Permissions") {
  // DEMO ONLY: a fixed table. A real application reads its database or its directory.
  static readonly layerMemory = Layer.sync(Permissions, () => {
    const table = new Map<string, ReadonlyArray<Permission>>([
      ["ada", ["tasks:read", "tasks:write"]],
      ["grace", ["tasks:read", "tasks:write"]],
      ["guest", ["tasks:read"]],
    ]);

    return Permissions.of({ granted: (memberId) => Effect.sync(() => table.get(memberId) ?? []) });
  });
}
