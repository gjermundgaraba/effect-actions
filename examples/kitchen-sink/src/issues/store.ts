import { Context, Effect, Layer, PubSub, Stream } from "effect";

import { IssueNotFound } from "./Issues.js";
import type { Comment, Issue, IssueChange, Status } from "./Issues.js";

export class IssueStore extends Context.Service<
  IssueStore,
  {
    readonly list: (
      workspace: string,
      status: typeof Status.Type | undefined,
      limit: number
    ) => Effect.Effect<readonly Issue[]>;
    readonly all: (
      workspace: string,
      status: typeof Status.Type | undefined
    ) => Stream.Stream<Issue>;
    readonly count: (
      workspace: string,
      status: typeof Status.Type | undefined
    ) => Effect.Effect<number>;
    readonly get: (
      workspace: string,
      id: string
    ) => Effect.Effect<Issue, IssueNotFound>;
    readonly create: (
      workspace: string,
      draft: Pick<Issue, "title" | "body" | "assignee">
    ) => Effect.Effect<Issue>;
    readonly comment: (
      workspace: string,
      id: string,
      comment: typeof Comment.Type
    ) => Effect.Effect<Issue, IssueNotFound>;
    readonly close: (
      workspace: string,
      id: string
    ) => Effect.Effect<Issue, IssueNotFound>;
    readonly changes: Stream.Stream<typeof IssueChange.Type>;
  }
>()("tracker/IssueStore") {
  static readonly layerMemory = Layer.effect(
    IssueStore,
    Effect.gen(function* () {
      const issues = new Map<string, Issue[]>();
      const changes = yield* PubSub.unbounded<typeof IssueChange.Type>();

      const publish = (
        workspace: string,
        issue: Issue,
        change: (typeof IssueChange.Type)["change"],
        comment?: typeof Comment.Type
      ) =>
        PubSub.publishUnsafe(changes, {
          workspace,
          id: issue.id,
          title: issue.title,
          status: issue.status,
          change,
          ...(comment === undefined ? {} : { comment }),
        });

      const of = (workspace: string) => issues.get(workspace) ?? [];

      const having = (
        workspace: string,
        status: typeof Status.Type | undefined
      ) =>
        of(workspace).filter(
          (issue) => status === undefined || issue.status === status
        );

      const get = Effect.fn("IssueStore.get")(function* (
        workspace: string,
        id: string
      ) {
        const issue = of(workspace).find((candidate) => candidate.id === id);

        if (issue === undefined) {
          return yield* new IssueNotFound({ id });
        }

        return issue;
      });

      const changedAtomically = (
        workspace: string,
        id: string,
        to: (issue: Issue) => Issue,
        kind: (typeof IssueChange.Type)["change"],
        comment?: typeof Comment.Type
      ): Issue | undefined => {
        const issue = of(workspace).find((candidate) => candidate.id === id);

        if (issue === undefined) {
          return undefined;
        }

        const changed = to(issue);

        if (changed === issue) {
          return issue;
        }

        issues.set(
          workspace,
          of(workspace).map((current) =>
            current === issue ? changed : current
          )
        );

        publish(workspace, changed, kind, comment);

        return changed;
      };

      const change = Effect.fn("IssueStore.change")(function* (
        workspace: string,
        id: string,
        to: (issue: Issue) => Issue,
        kind: (typeof IssueChange.Type)["change"],
        comment?: typeof Comment.Type
      ) {
        const changed = changedAtomically(workspace, id, to, kind, comment);

        if (changed === undefined) {
          return yield* new IssueNotFound({ id });
        }

        return changed;
      });

      return IssueStore.of({
        list: (workspace, status, limit) =>
          Effect.sync(() =>
            having(workspace, status).toReversed().slice(0, limit)
          ),
        all: (workspace, status) =>
          Stream.suspend(() => Stream.fromIterable(having(workspace, status))),
        count: (workspace, status) =>
          Effect.sync(() => having(workspace, status).length),
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
            publish(workspace, issue, "filed");

            return issue;
          }),
        comment: (workspace, id, comment) =>
          change(
            workspace,
            id,
            (issue) => ({ ...issue, comments: [...issue.comments, comment] }),
            "commented",
            comment
          ),
        close: (workspace, id) =>
          change(
            workspace,
            id,
            (issue) =>
              issue.status === "closed"
                ? issue
                : { ...issue, status: "closed" },
            "closed"
          ),
        changes: Stream.fromPubSub(changes),
      });
    })
  );
}
