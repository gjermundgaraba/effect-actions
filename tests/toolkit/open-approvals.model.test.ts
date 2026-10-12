import { expect, it } from "@effect/vitest";
import { Arbitrary, Effect, Match, Ref, Schema, Stream } from "effect";
import { Chat, LanguageModel, type Response } from "effect/ai";
import * as Action from "../../src/contract/Action.js";
import * as ActionToolkit from "../../src/toolkit/ActionToolkit.js";

const Erase = Action.make("erase", {
  description: "Erase",
  readOnly: false,
  caller: Action.Anyone,
  input: { id: Schema.String },
  success: Schema.String,
});

const Command = Schema.Union([
  Schema.TaggedStruct("Ask", {
    calls: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
  }),
  Schema.TaggedStruct("Answer", {
    picks: Schema.Array(
      Schema.Struct({
        place: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 })),
        approved: Schema.Boolean,
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
  }),
]);

const commands = Arbitrary.array(Arbitrary.schema(Command), { minLength: 1, maxLength: 12 });

const silence: ReadonlyArray<Response.PartEncoded> = [{ type: "text", text: "" }];

const requestsOf = (response: { readonly content: ReadonlyArray<Response.AnyPart> }) =>
  response.content.flatMap((part) =>
    part.type === "tool-approval-request"
      ? [{ approvalId: part.approvalId, toolCallId: part.toolCallId }]
      : [],
  );

it.effect.prop(
  "lists the requests asked and not yet answered, in the order they were asked, each with its call",
  [commands],
  ([turns]) =>
    Effect.gen(function* () {
      const { toolkit, layer } = ActionToolkit.make(
        Action.implement(Erase, ({ id }) => Effect.succeed(`erased ${id}`)),
        { needsApproval: () => true },
      );

      const replies = yield* Ref.make<ReadonlyArray<ReadonlyArray<Response.PartEncoded>>>([]);

      const model = yield* LanguageModel.make({
        generateText: () => Ref.modify(replies, ([next = silence, ...rest]) => [[...next], rest]),
        streamText: () => Stream.empty,
      });

      const chat = yield* Chat.empty;

      const turn = (prompt: Parameters<typeof chat.generateText>[0]["prompt"]) =>
        chat
          .generateText({ prompt, toolkit })
          .pipe(Effect.provideService(LanguageModel.LanguageModel, model), Effect.provide(layer));

      const asked: Array<{ readonly approvalId: string; readonly toolCallId: string }> = [];
      const answered = new Set<string>();
      let calls = 0;

      const open = () => asked.filter(({ approvalId }) => !answered.has(approvalId));

      for (const command of turns) {
        yield* Match.value(command).pipe(
          Match.tagsExhaustive({
            Ask: ({ calls: count }) =>
              Effect.gen(function* () {
                const ids = Array.from({ length: count }, () => `call-${++calls}`);

                yield* Ref.set(replies, [
                  ids.map(
                    (id) => ({ type: "tool-call", id, name: "erase", params: { id } }) as const,
                  ),
                ]);

                asked.push(...requestsOf(yield* turn("erase")));
              }),
            Answer: ({ picks }) =>
              Effect.gen(function* () {
                const waiting = open();

                if (waiting.length === 0) return;

                const answers = new Map(
                  picks.map(({ place, approved }) => [
                    waiting[place % waiting.length]?.approvalId ?? "",
                    approved,
                  ]),
                );

                yield* turn([
                  {
                    role: "tool",
                    content: [...answers].map(([approvalId, approved]) => ({
                      type: "tool-approval-response" as const,
                      approvalId,
                      approved,
                    })),
                  },
                ]);

                for (const approvalId of answers.keys()) answered.add(approvalId);
              }),
          }),
        );
      }

      expect(ActionToolkit.openApprovals(yield* Ref.get(chat.history))).toEqual(
        open().map(({ approvalId, toolCallId }) => ({
          approvalId,
          toolCallId,
          name: "erase",
          params: { id: toolCallId },
        })),
      );
    }),
  { arbitrary: { runs: 200 } },
);
