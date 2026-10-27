import { Context, Effect, Layer } from "effect";

export type Grant = "workspaces:read" | "workspaces:suspend";

/**
 * What each operator may do. An API key carries no scopes, so the grants are kept here, on the
 * server, and the authorizer looks them up.
 */
export class Grants extends Context.Service<
  Grants,
  { readonly of: (operator: string) => Effect.Effect<readonly Grant[]> }
>()("tracker/Grants") {
  // DEMO ONLY: fixed grants. A real application reads them from its database.
  static readonly layerDemo = Layer.sync(Grants, () => {
    const grants = new Map<string, readonly Grant[]>([
      ["ops", ["workspaces:read", "workspaces:suspend"]],
      ["support", ["workspaces:read"]],
    ]);

    return Grants.of({
      of: (operator) => Effect.sync(() => grants.get(operator) ?? []),
    });
  });
}
