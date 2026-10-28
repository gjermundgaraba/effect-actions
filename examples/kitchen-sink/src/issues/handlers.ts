import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Effect } from "effect";

import { authorize } from "../identity/authorize.js";
import { CurrentMember } from "../identity/Identity.js";
import { Issues } from "./Issues.js";
import { IssueStore } from "./store.js";
import { writeLimit } from "./write-limit.js";

export const issues = Action.implement(
  Issues,
  Effect.gen(function* () {
    const store = yield* IssueStore;
    const limited = yield* writeLimit;

    return {
      listIssues: ({ status, limit }) =>
        Effect.gen(function* () {
          const member = yield* CurrentMember;
          const listed = yield* store.list(member.workspace, status, limit);

          return {
            issues: listed.map((issue) => ({
              id: issue.id,
              title: issue.title,
              status: issue.status,
            })),
          };
        }),
      getIssue: ({ id }) =>
        Effect.flatMap(CurrentMember, (member) =>
          store.get(member.workspace, id)
        ),
      createIssue: (draft) =>
        limited((member) => store.create(member.workspace, draft)),
      commentOnIssue: ({ id, text }) =>
        limited((member) =>
          store.comment(member.workspace, id, { author: member.id, text })
        ),
      closeIssue: ({ id }) =>
        limited((member) => store.close(member.workspace, id)),
    };
  }),
  { authorize }
);
