import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionToolkit from "@gjermundgaraba/effect-actions/ActionToolkit";
import { Effect, Ref, Schema } from "effect";
import { LanguageModel } from "effect/ai";
import type { Chat, Prompt } from "effect/ai";

import { CurrentMember } from "../identity/Identity.js";
import { toolkit } from "../issues/assistant.js";
import { AssistantFailed, Assistant } from "./Assistant.js";
import { Conversations } from "./conversations.js";

const requestsPerTurn = 6;

type Response = LanguageModel.GenerateTextResponse<
  typeof toolkit.tools,
  "opaque"
>;

const approvalsOf = (response: Response) =>
  response.content.filter((part) => part.type === "tool-approval-request");

const didNotRun = Schema.is(
  Schema.Struct({
    type: Schema.Literals(["execution-denied", "execution-interrupted"]),
  })
);

const callsToRead = (response: Response) =>
  response.toolCalls.length > 0 && approvalsOf(response).length === 0;

export const assistant = Action.implement(
  Assistant,
  Effect.gen(function* () {
    const tools = yield* toolkit;
    const model = yield* LanguageModel.LanguageModel;
    const conversations = yield* Conversations;

    const converse = (
      conversation: string,
      chat: Chat.Chat,
      prompt: Prompt.RawInput
    ) =>
      Effect.gen(function* () {
        let response = yield* chat.generateText({ prompt, toolkit: tools });
        const results = [...response.toolResults];

        for (
          let asked = 1;
          asked < requestsPerTurn && callsToRead(response);
          asked += 1
        ) {
          response = yield* chat.generateText({ prompt: [], toolkit: tools });
          results.push(...response.toolResults);
        }

        return {
          conversation,
          text: response.text,
          ran: results
            .values()
            .filter(({ result }) => !didNotRun(result))
            .map(({ name, isFailure }) => ({ tool: name, failed: isFailure }))
            .toArray(),
          waiting: ActionToolkit.openApprovals(
            yield* Ref.get(chat.history)
          ).map(({ approvalId, name, params }) => ({
            approvalId,
            tool: name,
            arguments: JSON.stringify(params),
          })),
        };
      }).pipe(Effect.provideService(LanguageModel.LanguageModel, model));

    const turn = (conversation: string, prompt: Prompt.RawInput) =>
      Effect.flatMap(CurrentMember, (member) =>
        conversations.turn(member, conversation, (chat) =>
          converse(conversation, chat, prompt)
        )
      ).pipe(
        Effect.catchTag("AiError", () =>
          Effect.fail(
            new AssistantFailed({
              message:
                "The model failed and this conversation has ended. A call you approved in this turn may have run: read the issue before asking again.",
            })
          )
        )
      );

    return {
      askAssistant: ({ prompt, conversation }) =>
        conversation === undefined
          ? Effect.flatMap(
              Effect.flatMap(CurrentMember, conversations.open),
              (opened) => turn(opened, prompt)
            )
          : turn(conversation, prompt),
      answerAssistant: ({ conversation, answers }) =>
        turn(conversation, [
          {
            role: "tool",
            content: answers.map(({ approvalId, approved }) => ({
              type: "tool-approval-response" as const,
              approvalId,
              approved,
            })),
          },
        ]),
    };
  }),
  { authorize: Action.allowAll }
);
