import { Effect, Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { CurrentMember } from "../identity/Identity.js";

export const Status = Schema.Literals(["open", "closed"]);

export const Comment = Schema.Struct({ author: Schema.String, text: Schema.String });

export const Issue = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  body: Schema.String,
  status: Status,
  assignee: Schema.optional(Schema.String),
  comments: Schema.Array(Comment),
});

export type Issue = typeof Issue.Type;

// A declared error is part of the contract: every client decodes it as this class, and its
// status is what HTTP answers with. Without `httpApiStatus` it would be a 422.
export class IssueNotFound extends Schema.TaggedError<IssueNotFound>()(
  "IssueNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

export class RateLimited extends Schema.TaggedError<RateLimited>()(
  "RateLimited",
  { retryAfterSeconds: Schema.Finite },
  { httpApiStatus: 429 },
) {}

// A shared error list: what any write to an existing issue may fail with. Each such action
// names this one array as its `error`, here and in attachments/Attachments.ts, so an error
// added to the list is declared by all of them.
export const IssueWriteErrors = [IssueNotFound, RateLimited] as const;

// An option bundle. What the two actions changing an issue share is one constant object spread
// into `Action.make`, typed as if written inline. `readOnly` and `description` stay on each
// action.
const change = {
  caller: CurrentMember,
  error: IssueWriteErrors,
  // MCP hints, in MCP's names. They tell a model what a tool does and enforce nothing; the
  // read-only hint is `readOnly` itself. A write is destructive unless it only adds, as a
  // comment does: closing is not stated `false`.
  mcp: { openWorldHint: false },
} as const;

const Text = Schema.String.check(Schema.isMinLength(1));

export const ListIssues = Action.make("listIssues", {
  description: "List your workspace's issues, newest first, without bodies or comments.",
  input: {
    // Optional: left out, issues of every status are listed.
    status: Schema.optional(Status),
    // Defaulted: left out, the handler receives 20. A field description is also the help text
    // of its CLI flag and the description in the tool's schema.
    limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).pipe(
      Schema.annotate({ description: "How many issues to list, at most 100." }),
      Schema.withDecodingDefaultKey(Effect.succeed(20)),
    ),
  },
  success: {
    issues: Schema.Array(
      Schema.Struct({ id: Schema.String, title: Schema.String, status: Status }),
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
  input: { title: Text, body: Schema.String, assignee: Schema.optional(Schema.String) },
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

export const Issues = [ListIssues, GetIssue, CreateIssue, CommentOnIssue, CloseIssue] as const;
