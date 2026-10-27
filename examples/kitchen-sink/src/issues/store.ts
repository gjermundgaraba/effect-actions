import { Context, Effect, Layer, PubSub, Stream } from "effect";

import { IssueNotFound } from "./Issues.js";
import type { Comment, Issue, IssueChange, Status } from "./Issues.js";

/**
 * Where issues live, each in one workspace. Every method but `changes` takes the workspace, so
 * tenant isolation is the data access's: no surface and no handler can skip it, and an issue of
 * another workspace is simply not found.
 */
export class IssueStore extends Context.Service<
  IssueStore,
  {
    readonly list: (
      workspace: string,
      status: typeof Status.Type | undefined,
      limit: number
    ) => Effect.Effect<readonly Issue[]>;
    /** Every issue, oldest first. */
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
    /**
     * Every change from now on, in the order the store makes them, of every workspace: whatever
     * reads it filters by workspace itself, as `issueEvents`' `match` does.
     */
    readonly changes: Stream.Stream<typeof IssueChange.Type>;
  }
>()("tracker/IssueStore") {
  // DEMO ONLY: memory, lost when the process stops. A real store is another Layer of this
  // service, chosen by the entrypoint.
  static readonly layerMemory = Layer.effect(
    IssueStore,
    Effect.gen(function* () {
      const issues = new Map<string, Issue[]>();
      const changes = yield* PubSub.unbounded<typeof IssueChange.Type>();

      // Published in the step of the write, after it, so a subscriber never sees a change the
      // store did not make, and sees them in the order they were made. A database publishes
      // from its own change feed, or an outbox written in the same transaction.
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

      // No `yield*` between the read and the write: a fiber may be set aside at one, and two
      // changes that each read the issue before either wrote would keep only the second. A
      // database does this in one statement or a transaction.
      // A change `to` answers with the same issue for is no change, and is not published.
      const change = Effect.fn("IssueStore.change")(function* (
        workspace: string,
        id: string,
        to: (issue: Issue) => Issue,
        kind: (typeof IssueChange.Type)["change"],
        comment?: typeof Comment.Type
      ) {
        const issue = of(workspace).find((candidate) => candidate.id === id);

        if (issue === undefined) {
          return yield* new IssueNotFound({ id });
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
      });

      return IssueStore.of({
        list: (workspace, status, limit) =>
          Effect.sync(() =>
            having(workspace, status).toReversed().slice(0, limit)
          ),
        // A database reads it in pages, by id, so an export never holds the workspace whole.
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
