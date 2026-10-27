import { describe, expect, it } from "@effect/vitest";
import { Effect, Ref, Schema, Stream } from "effect";
import { AiError, Chat, LanguageModel } from "effect/ai";
import type { Response } from "effect/ai";

import * as Action from "../../src/contract/Action.js";
import * as ActionToolkit from "../../src/toolkit/ActionToolkit.js";

const Erase = Action.make("erase", {
  description: "Erase",
  readOnly: false,
  caller: Action.Anyone,
  input: { id: Schema.String },
  success: Schema.String,
});

const erasing = (id: string) =>
  ({ type: "tool-call", id, name: "erase", params: { id } }) as const;

const conversation = (
  replies: ReadonlyArray<readonly Response.PartEncoded[] | "fails">
) =>
  Effect.gen(function* () {
    const erased: string[] = [];
    const requests = yield* Ref.make(0);

    const { toolkit, layer } = ActionToolkit.make(
      Action.implement(Erase, ({ id }) =>
        Effect.as(
          Effect.sync(() => erased.push(id)),
          `erased ${id}`
        )
      ),
      { needsApproval: () => true }
    );

    const model = yield* LanguageModel.make({
      generateText: () =>
        Effect.flatMap(
          Ref.getAndUpdate(requests, (count) => count + 1),
          (count) => {
            const reply = replies[count] ?? [];

            return reply === "fails"
              ? Effect.fail(
                  AiError.make({
                    module: "approval-turns",
                    method: "generateText",
                    reason: new AiError.UnknownError({
                      description: "The model is down",
                    }),
                  })
                )
              : Effect.succeed([...reply]);
          }
        ),
      streamText: () => Stream.empty,
    });

    const chat = yield* Chat.empty;

    const turn = (prompt: Parameters<typeof chat.generateText>[0]["prompt"]) =>
      chat
        .generateText({ prompt, toolkit })
        .pipe(
          Effect.provideService(LanguageModel.LanguageModel, model),
          Effect.provide(layer)
        );

    const answering = (...answers: ReadonlyArray<readonly [string, boolean]>) =>
      turn([
        {
          role: "tool",
          content: answers.map(([approvalId, approved]) => ({
            type: "tool-approval-response" as const,
            approvalId,
            approved,
          })),
        },
      ]);

    return { erased, requests, chat, turn, answering };
  });

const approvalIdsOf = (response: {
  readonly content: readonly Response.AnyPart[];
}) =>
  response.content.flatMap((part) =>
    part.type === "tool-approval-request" ? [part.approvalId] : []
  );

describe("turns of a conversation that asks approval", () => {
  it.effect(
    "answers each request on its own: an approved call runs before the model is asked once, and one left unanswered stays open",
    () =>
      Effect.gen(function* () {
        const { erased, requests, turn, answering } = yield* conversation([
          [erasing("a"), erasing("b")],
          [{ type: "text", text: "one erased" }],
          [{ type: "text", text: "both erased" }],
        ]);

        const asked = yield* turn("erase a and b");
        const [first = "", second = ""] = approvalIdsOf(asked);

        expect(asked.toolResults).toStrictEqual([]);
        expect(erased).toStrictEqual([]);

        const one = yield* answering([first, true]);

        expect(erased).toStrictEqual(["a"]);
        expect(yield* Ref.get(requests)).toBe(2);
        expect(one.text).toBe("one erased");
        expect(one.toolResults.map(({ result }) => result)).toStrictEqual([
          "erased a",
        ]);
        expect(one.toolCalls).toStrictEqual([]);
        expect(approvalIdsOf(one)).toStrictEqual([]);

        const two = yield* answering([second, true]);

        expect(erased).toStrictEqual(["a", "b"]);
        expect(yield* Ref.get(requests)).toBe(3);
        expect(two.toolResults.map(({ result }) => result)).toStrictEqual([
          "erased b",
        ]);
      })
  );

  it.effect(
    "has run an approved call when the model then fails, records nothing of that turn, and runs the call again for the same answer",
    () =>
      Effect.gen(function* () {
        const { erased, chat, turn, answering } = yield* conversation([
          [erasing("a")],
          "fails",
          [{ type: "text", text: "erased" }],
        ]);

        const asked = yield* turn("erase a");
        const [first = ""] = approvalIdsOf(asked);
        const recorded = yield* Ref.get(chat.history);

        const failed = yield* Effect.flip(answering([first, true]));

        expect(failed).toBeInstanceOf(AiError.AiError);
        expect(erased).toStrictEqual(["a"]);
        expect(yield* Ref.get(chat.history)).toStrictEqual(recorded);

        yield* answering([first, true]);

        expect(erased).toStrictEqual(["a", "a"]);
      })
  );
});
