import { Context, Effect, Layer } from "effect";

export type Grant = "workspaces:read" | "workspaces:suspend";

export class Grants extends Context.Service<
  Grants,
  { readonly of: (operator: string) => Effect.Effect<readonly Grant[]> }
>()("tracker/Grants") {
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
