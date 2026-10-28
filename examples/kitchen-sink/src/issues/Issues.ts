import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect, Schema } from "effect";

import { CurrentMember } from "../identity/Identity.js";

export const Status = Schema.Literals(["open", "closed"]);

export const Comment = Schema.Struct({
  author: Schema.String,
  text: Schema.String,
});

export const Issue = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  body: Schema.String,
  status: Status,
  assignee: Schema.optional(Schema.String),
  comments: Schema.Array(Comment),
});

export type Issue = typeof Issue.Type;

export class IssueNotFound extends Schema.TaggedError<
  IssueNotFound,
  { readonly brand: unique symbol }
>()("IssueNotFound", { id: Schema.String }, { httpApiStatus: 404 }) {}

export class RateLimited extends Schema.TaggedError<
  RateLimited,
  { readonly brand: unique symbol }
>()(
  "RateLimited",
  { retryAfterSeconds: Schema.Finite },
  { httpApiStatus: 429 }
) {}

export const IssueWriteErrors = [IssueNotFound, RateLimited] as const;

const change = {
  caller: CurrentMember,
  error: IssueWriteErrors,
  mcp: { openWorldHint: false },
} as const;

const Text = Schema.String.check(Schema.isMinLength(1));

export const ListIssues = Action.make("listIssues", {
  description:
    "List your workspace's issues, newest first, without bodies or comments.",
  input: {
    status: Schema.optional(Status),
    limit: Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: 100 })
    ).pipe(
      Schema.annotate({ description: "How many issues to list, at most 100." }),
      Schema.withDecodingDefaultKey(Effect.succeed(20))
    ),
  },
  success: {
    issues: Schema.Array(
      Schema.Struct({ id: Schema.String, title: Schema.String, status: Status })
    ),
  },
  readOnly: true,
  caller: CurrentMember,
});

export const GetIssue = Action.make("getIssue", {
  description: "Read one issue with its comments.",
  input: { id: Schema.String },
  success: Issue,
  error: IssueNotFound,
  readOnly: true,
  caller: CurrentMember,
});

export const CreateIssue = Action.make("createIssue", {
  description: "File an issue in your workspace.",
  input: {
    title: Text,
    body: Schema.String,
    assignee: Schema.optional(Schema.String),
  },
  success: Issue,
  error: RateLimited,
  readOnly: false,
  caller: CurrentMember,
  mcp: { title: "File an issue", destructiveHint: false, openWorldHint: false },
});

export const CommentOnIssue = Action.make("commentOnIssue", {
  ...change,
  description: "Add a comment to an issue.",
  input: { id: Schema.String, text: Text },
  success: Issue,
  readOnly: false,
  mcp: { ...change.mcp, destructiveHint: false },
});

export const CloseIssue = Action.make("closeIssue", {
  ...change,
  description: "Close an issue. Closing a closed issue changes nothing.",
  input: { id: Schema.String },
  success: Issue,
  readOnly: false,
  mcp: { ...change.mcp, idempotentHint: true },
});

export const Issues = [
  ListIssues,
  GetIssue,
  CreateIssue,
  CommentOnIssue,
  CloseIssue,
] as const;

export const ExportIssues = Action.make("exportIssues", {
  description:
    "Stream every issue of your workspace, oldest first, with bodies and comments.",
  input: {
    status: Schema.optional(Status).annotate({
      description: "Only issues of this status.",
    }),
  },
  success: Action.Stream(Issue),
  progress: {
    exported: Schema.Finite.annotate({
      description: "How many issues were sent.",
    }),
    total: Schema.Finite.annotate({
      description: "How many the export holds.",
    }),
  },
  error: RateLimited,
  readOnly: true,
  caller: CurrentMember,
});

export const IssueChange = Schema.Struct({
  workspace: Schema.String,
  id: Schema.String,
  title: Schema.String,
  status: Status,
  change: Schema.Literals(["filed", "commented", "closed"]),
  comment: Schema.optional(Comment),
});

export const IssueChanged = Event.make("issue.changed", {
  description: "An issue in your workspace was filed, commented on or closed.",
  input: {
    status: Schema.optional(Status).annotate({
      description: "Only issues now of this status.",
    }),
    comments: Schema.optional(Schema.Boolean).annotate({
      description:
        "Whether a change carries the comment it added; omitted, it does.",
    }),
  },
  payload: IssueChange,
  caller: CurrentMember,
});
