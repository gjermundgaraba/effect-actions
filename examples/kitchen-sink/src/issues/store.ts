import { Context, Effect, Layer } from "effect";
import { type Comment, type Issue, IssueNotFound, type Status } from "./Issues.js";

/**
 * Where issues live, each in one workspace. Every method takes the workspace, so tenant
 * isolation is the data access's: no surface and no handler can skip it, and an issue of
 * another workspace is simply not found.
 */
export class IssueStore extends Context.Service<
  IssueStore,
  {
    readonly list: (
      workspace: string,
      status: typeof Status.Type | undefined,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<Issue>>;
    readonly get: (workspace: string, id: string) => Effect.Effect<Issue, IssueNotFound>;
    readonly create: (
      workspace: string,
      draft: Pick<Issue, "title" | "body" | "assignee">,
    ) => Effect.Effect<Issue>;
    readonly comment: (
      workspace: string,
      id: string,
      comment: typeof Comment.Type,
    ) => Effect.Effect<Issue, IssueNotFound>;
    readonly close: (workspace: string, id: string) => Effect.Effect<Issue, IssueNotFound>;
  }
>()("tracker/IssueStore") {
  // DEMO ONLY: memory, lost when the process stops. A real store is another Layer of this
  // service, chosen by the entrypoint.
  static readonly layerMemory = Layer.sync(IssueStore, () => {
    const issues = new Map<string, Array<Issue>>();

    const of = (workspace: string) => issues.get(workspace) ?? [];

    const get = Effect.fn("IssueStore.get")(function* (workspace: string, id: string) {
      const issue = of(workspace).find((candidate) => candidate.id === id);

      if (issue === undefined) return yield* new IssueNotFound({ id });

      return issue;
    });

    const replace = (workspace: string, issue: Issue) =>
      Effect.sync(() => {
        issues.set(
          workspace,
          of(workspace).map((current) => (current.id === issue.id ? issue : current)),
        );

        return issue;
      });

    return IssueStore.of({
      list: (workspace, status, limit) =>
        Effect.sync(() =>
          of(workspace)
            .filter((issue) => status === undefined || issue.status === status)
            .toReversed()
            .slice(0, limit),
        ),
      get,
      create: (workspace, draft) =>
        Effect.sync(() => {
          const existing = of(workspace);

          const issue: Issue = {
            ...draft,
            id: `${workspace.toUpperCase()}-${existing.length + 1}`,
            status: "open",
            comments: [],
          };

          issues.set(workspace, [...existing, issue]);

          return issue;
        }),
      comment: Effect.fn("IssueStore.comment")(function* (workspace, id, comment) {
        const issue = yield* get(workspace, id);

        return yield* replace(workspace, { ...issue, comments: [...issue.comments, comment] });
      }),
      close: Effect.fn("IssueStore.close")(function* (workspace, id) {
        return yield* replace(workspace, { ...(yield* get(workspace, id)), status: "closed" });
      }),
    });
  });
}
