import { Effect } from "effect";
import { LanguageModel, type Prompt } from "effect/ai";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { CurrentMember, type Member } from "../identity/Identity.js";
import { toolkit } from "../issues/assistant.js";
import { AssistantFailed, Assistant } from "./Assistant.js";
import { type Conversation, Conversations } from "./conversations.js";

// A model that keeps calling tools is asked this many times in one turn, and no more.
const requestsPerTurn = 6;

type Response = LanguageModel.GenerateTextResponse<typeof toolkit.tools, "opaque">;

const approvalsOf = (response: Response) =>
  response.content.filter((part) => part.type === "tool-approval-request");

const callsToRead = (response: Response) =>
  response.toolCalls.length > 0 && approvalsOf(response).length === 0;

// The model loop behind a route. The builder runs once, at startup, and yields what a turn is
// built from: the tools with their handlers, the model, and where conversations are kept. A
// handler yielding them would owe them per request, which no route provides. `CurrentMember`
// is the one per-request service: each tool call of a turn runs as the request's caller,
// through that tool's own `authorize`.
export const assistant = Action.implement(
  Assistant,
  Effect.gen(function* () {
    const tools = yield* toolkit;
    const model = yield* LanguageModel.LanguageModel;
    const conversations = yield* Conversations;

    const turn = (member: Member, { id, chat, turn }: Conversation, prompt: Prompt.RawInput) =>
      Effect.gen(function* () {
        // One `generateText` is one request to the model: its tool calls run, and their
        // results come back unread. The model is asked again, with nothing new, while it
        // called tools and none of them waits for approval. Continue on tool calls, never on
        // tool results: the turn answering an approval holds the approved call's result and
        // the model's reply to it.
        let response = yield* chat.generateText({ prompt, toolkit: tools });
        const results = [...response.toolResults];

        for (let asked = 1; asked < requestsPerTurn && callsToRead(response); asked++) {
          response = yield* chat.generateText({ prompt: [], toolkit: tools });
          results.push(...response.toolResults);
        }

        return {
          conversation: id,
          text: response.text,
          // A refusal or a declared error is a result too, which the model has read.
          ran: results.map(({ name, isFailure }) => ({ tool: name, failed: isFailure })),
          waiting: approvalsOf(response).flatMap(({ approvalId, toolCallId }) =>
            response.toolCalls
              .filter((call) => call.id === toolCallId)
              .map((call) => ({
                approvalId,
                tool: call.name,
                arguments: JSON.stringify(call.params),
              })),
          ),
        };
      }).pipe(
        // The model is a startup service, given to each turn here.
        Effect.provideService(LanguageModel.LanguageModel, model),
        // If the model fails after an approved call, the call has run and the `Chat` has
        // recorded nothing of the turn: the same answer sent again would run the call again.
        // So a failed turn ends its conversation, and the error says what may have happened.
        Effect.catchTag("AiError", () =>
          Effect.andThen(
            conversations.end(member, id),
            Effect.fail(
              new AssistantFailed({
                message:
                  "The model failed and this conversation has ended. A call you approved in this turn may have run: read the issue before asking again.",
              }),
            ),
          ),
        ),
        turn.withPermits(1),
      );

    return {
      askAssistant: ({ prompt, conversation }) =>
        Effect.gen(function* () {
          const member = yield* CurrentMember;

          const open =
            conversation === undefined
              ? yield* conversations.open(member)
              : yield* conversations.find(member, conversation);

          return yield* turn(member, open, prompt);
        }),
      // The answers start the next turn, in which an approved call runs, as this request's
      // caller, before the model is asked again. Only the member who was asked reaches the
      // conversation, and an `approvalId` that matches no open request of it runs nothing.
      answerAssistant: ({ conversation, answers }) =>
        Effect.gen(function* () {
          const member = yield* CurrentMember;
          const open = yield* conversations.find(member, conversation);

          return yield* turn(member, open, [
            {
              role: "tool",
              content: answers.map(({ approvalId, approved }) => ({
                type: "tool-approval-response" as const,
                approvalId,
                approved,
              })),
            },
          ]);
        }),
    };
  }),
  // Any member may ask. What the assistant may do for them is each tool's rule, not this one:
  // a member without the write scope gets the tool's refusal as a result the model reads.
  { authorize: Action.allowAll },
);
