import { Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { CurrentMember } from "../identity/Identity.js";

// The assistant behind a route: a model working on the issues with the tools of
// issues/assistant.ts, one request per turn of a conversation. A request starts a turn and its
// answer is the turn's end: the model's text, or the calls that wait for the member's approval.

/**
 * What a turn ended with. A call in `ran` ran in this turn, `failed` where it was refused or
 * failed with a declared error; one the member denied, or one in a reply the provider cut
 * short, did not run and is not listed. A call in `waiting` has not run: `answerAssistant`
 * decides it. `waiting` holds what this turn asked: a call left unanswered by an earlier
 * answer stays open, and is not listed again.
 */
export const Turn = Schema.Struct({
  conversation: Schema.String,
  text: Schema.String,
  ran: Schema.Array(Schema.Struct({ tool: Schema.String, failed: Schema.Boolean })),
  waiting: Schema.Array(
    Schema.Struct({
      approvalId: Schema.String,
      tool: Schema.String,
      // The arguments the model gave the call, as JSON text: what the member approves.
      arguments: Schema.String,
    }),
  ),
});

// Another member's conversation is not found either: an id tells nothing of who holds it.
export class ConversationNotFound extends Schema.TaggedError<ConversationNotFound>()(
  "ConversationNotFound",
  { conversation: Schema.String },
  { httpApiStatus: 404 },
) {}

// The model failed in the middle of a turn. The conversation is over: its history holds
// nothing of that turn, so it no longer says which calls ran.
export class AssistantFailed extends Schema.TaggedError<AssistantFailed>()(
  "AssistantFailed",
  { message: Schema.String },
  { httpApiStatus: 502 },
) {}

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

export const AnswerAssistant = Action.make("answerAssistant", {
  description: "Approve or deny the calls a turn of your conversation waits for.",
  input: {
    conversation: Schema.String,
    // Each request once. Effect acts on every answer it is given: an `approvalId` approved
    // twice in one request would run its call twice.
    answers: Schema.Array(
      Schema.Struct({ approvalId: Schema.String, approved: Schema.Boolean }),
    ).check(
      Schema.makeFilter(
        (answers) =>
          new Set(answers.map(({ approvalId }) => approvalId)).size === answers.length ||
          "Answer each approvalId once",
      ),
    ),
  },
  success: Turn,
  error: [ConversationNotFound, AssistantFailed],
  readOnly: false,
  caller: CurrentMember,
});

export const Assistant = [AskAssistant, AnswerAssistant] as const;
