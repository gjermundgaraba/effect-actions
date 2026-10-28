import { Context, Effect, Layer } from "effect";

import { WorkspaceNotFound } from "./Workspaces.js";
import type { Workspace } from "./Workspaces.js";

export class WorkspaceRegistry extends Context.Service<
  WorkspaceRegistry,
  {
    readonly list: Effect.Effect<readonly Workspace[]>;
    readonly get: (slug: string) => Effect.Effect<Workspace, WorkspaceNotFound>;
    readonly setSuspended: (
      slug: string,
      suspended: boolean
    ) => Effect.Effect<Workspace, WorkspaceNotFound>;
  }
>()("tracker/WorkspaceRegistry") {
  static readonly layerMemory = Layer.sync(WorkspaceRegistry, () => {
    const workspaces = new Map<string, Workspace>([
      ["acme", { slug: "acme", name: "Acme", suspended: false }],
      ["globex", { slug: "globex", name: "Globex", suspended: false }],
    ]);

    const get = Effect.fn("WorkspaceRegistry.get")(function* (slug: string) {
      const workspace = workspaces.get(slug);

      if (workspace === undefined) {
        return yield* new WorkspaceNotFound({ slug });
      }

      return workspace;
    });

    return WorkspaceRegistry.of({
      list: Effect.sync(() => [...workspaces.values()]),
      get,
      setSuspended: Effect.fn("WorkspaceRegistry.setSuspended")(
        function* (slug, suspended) {
          const workspace = { ...(yield* get(slug)), suspended };

          workspaces.set(slug, workspace);

          return workspace;
        }
      ),
    });
  });
}
