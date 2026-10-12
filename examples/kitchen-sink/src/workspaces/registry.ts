import { Context, Effect, Layer } from "effect";
import { type Workspace, WorkspaceNotFound } from "./Workspaces.js";

/**
 * The tenants. Operators list and suspend them on the admin port; authentication reads the
 * suspension on the public one, so both servers must share this one service.
 */
export class WorkspaceRegistry extends Context.Service<
  WorkspaceRegistry,
  {
    readonly list: Effect.Effect<ReadonlyArray<Workspace>>;
    readonly get: (slug: string) => Effect.Effect<Workspace, WorkspaceNotFound>;
    readonly setSuspended: (
      slug: string,
      suspended: boolean,
    ) => Effect.Effect<Workspace, WorkspaceNotFound>;
  }
>()("tracker/WorkspaceRegistry") {
  // DEMO ONLY: two workspaces in memory. A real registry is another Layer of this service.
  static readonly layerMemory = Layer.sync(WorkspaceRegistry, () => {
    const workspaces = new Map<string, Workspace>([
      ["acme", { slug: "acme", name: "Acme", suspended: false }],
      ["globex", { slug: "globex", name: "Globex", suspended: false }],
    ]);

    const get = Effect.fn("WorkspaceRegistry.get")(function* (slug: string) {
      const workspace = workspaces.get(slug);

      if (workspace === undefined) return yield* new WorkspaceNotFound({ slug });

      return workspace;
    });

    return WorkspaceRegistry.of({
      list: Effect.sync(() => Array.from(workspaces.values())),
      get,
      setSuspended: Effect.fn("WorkspaceRegistry.setSuspended")(function* (slug, suspended) {
        const workspace = { ...(yield* get(slug)), suspended };

        workspaces.set(slug, workspace);

        return workspace;
      }),
    });
  });
}
