import { Context, Effect, Layer, Stream } from "effect";
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
    /** Every issue, oldest first. */
    readonly all: (
      workspace: string,
      status: typeof Status.Type | undefined,
    ) => Stream.Stream<Issue>;
    readonly count: (
      workspace: string,
      status: typeof Status.Type | undefined,
    ) => Effect.Effect<number>;
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

    const having = (workspace: string, status: typeof Status.Type | undefined) =>
      of(workspace).filter((issue) => status === undefined || issue.status === status);

    const get = Effect.fn("IssueStore.get")(function* (workspace: string, id: string) {
      const issue = of(workspace).find((candidate) => candidate.id === id);

      if (issue === undefined) return yield* new IssueNotFound({ id });

      return issue;
    });

    // No `yield*` between the read and the write: a fiber may be set aside at one, and two
    // changes that each read the issue before either wrote would keep only the second. A
    // database does this in one statement or a transaction.
    const change = Effect.fn("IssueStore.change")(function* (
      workspace: string,
      id: string,
      to: (issue: Issue) => Issue,
    ) {
      const issue = of(workspace).find((candidate) => candidate.id === id);

      if (issue === undefined) return yield* new IssueNotFound({ id });

      const changed = to(issue);

      issues.set(
        workspace,
        of(workspace).map((current) => (current === issue ? changed : current)),
      );

      return changed;
    });

    return IssueStore.of({
      list: (workspace, status, limit) =>
        Effect.sync(() => having(workspace, status).toReversed().slice(0, limit)),
      // A database reads it in pages, by id, so an export never holds the workspace whole.
      all: (workspace, status) =>
        Stream.suspend(() => Stream.fromIterable(having(workspace, status))),
      count: (workspace, status) => Effect.sync(() => having(workspace, status).length),
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
      comment: (workspace, id, comment) =>
        change(workspace, id, (issue) => ({ ...issue, comments: [...issue.comments, comment] })),
      close: (workspace, id) => change(workspace, id, (issue) => ({ ...issue, status: "closed" })),
    });
  });
}
