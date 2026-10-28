import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Schema } from "effect";

import { CurrentMember } from "../identity/Identity.js";

export const Turn = Schema.Struct({
  conversation: Schema.String,
  text: Schema.String,
  ran: Schema.Array(
    Schema.Struct({ tool: Schema.String, failed: Schema.Boolean })
  ),
  waiting: Schema.Array(
    Schema.Struct({
      approvalId: Schema.String,
      tool: Schema.String,
      arguments: Schema.String,
    })
  ),
});

export class ConversationNotFound extends Schema.TaggedError<
  ConversationNotFound,
  { readonly brand: unique symbol }
>()(
  "ConversationNotFound",
  { conversation: Schema.String },
  { httpApiStatus: 404 }
) {}

export class AssistantFailed extends Schema.TaggedError<
  AssistantFailed,
  { readonly brand: unique symbol }
>()("AssistantFailed", { message: Schema.String }, { httpApiStatus: 502 }) {}

export const AskAssistant = Action.make("askAssistant", {
  description:
    "Ask the assistant about your workspace's issues, in a new conversation or one of yours.",
  input: {
    prompt: Schema.String.check(Schema.isMinLength(1)),
    conversation: Schema.optional(Schema.String).annotate({
      description: "The conversation to continue. Left out, a new one starts.",
    }),
  },
  success: Turn,
  error: [ConversationNotFound, AssistantFailed],
  readOnly: false,
  caller: CurrentMember,
});

const uniqueApprovalIds = Schema.makeFilter(
  (answers: ReadonlyArray<{ readonly approvalId: string }>) =>
    new Set(answers.map(({ approvalId }) => approvalId)).size ===
      answers.length || "Answer each approvalId once"
);

export const AnswerAssistant = Action.make("answerAssistant", {
  description:
    "Approve or deny the calls a turn of your conversation waits for.",
  input: {
    conversation: Schema.String,
    answers: Schema.Array(
      Schema.Struct({ approvalId: Schema.String, approved: Schema.Boolean })
    ).check(uniqueApprovalIds),
  },
  success: Turn,
  error: [ConversationNotFound, AssistantFailed],
  readOnly: false,
  caller: CurrentMember,
});

export const Assistant = [AskAssistant, AnswerAssistant] as const;
