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
    streamedTurnFails: Schema.Boolean,
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
      const dying = yield* Ref.make(false);

      const { toolkit, layer } = ActionToolkit.make(
        Action.implement(Erase, ({ id }) =>
          Effect.flatMap(Ref.get(dying), (dies) =>
            dies ? Effect.die("the turn failed") : Effect.succeed(`erased ${id}`),
          ),
        ),
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

      const failingStreamedTurn = (prompt: Parameters<typeof chat.streamText>[0]["prompt"]) =>
        Ref.set(dying, true).pipe(
          Effect.andThen(Stream.runDrain(chat.streamText({ prompt, toolkit }))),
          Effect.provideService(LanguageModel.LanguageModel, model),
          Effect.provide(layer),
          Effect.exit,
          Effect.ensuring(Ref.set(dying, false)),
        );

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
            Answer: ({ streamedTurnFails, picks }) =>
              Effect.gen(function* () {
                const waiting = open();

                if (waiting.length === 0) return;

                const answers = new Map(
                  picks.map(({ place, approved }) => [
                    waiting[place % waiting.length]?.approvalId ?? "",
                    approved,
                  ]),
                );

                const prompt = [
                  {
                    role: "tool" as const,
                    content: [...answers].map(([approvalId, approved]) => ({
                      type: "tool-approval-response" as const,
                      approvalId,
                      approved,
                    })),
                  },
                ];

                yield* streamedTurnFails
                  ? failingStreamedTurn(prompt)
                  : Effect.asVoid(turn(prompt));

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

it.effect(
  "lists exactly the calls that approving every listed request runs, in a history that repeats ids",
  () =>
    Effect.gen(function* () {
      const erased: Array<string> = [];

      const { toolkit, layer } = ActionToolkit.make(
        Action.implement(Erase, ({ id }) =>
          Effect.sync(() => {
            erased.push(id);

            return `erased ${id}`;
          }),
        ),
        { needsApproval: () => true },
      );

      const model = yield* LanguageModel.make({
        generateText: () => Effect.succeed([...silence]),
        streamText: () => Stream.empty,
      });

      const chat = yield* Chat.fromPrompt([
        { role: "user", content: "erase" },
        {
          role: "assistant",
          content: [
            { type: "tool-call", id: "repeated", name: "erase", params: { id: "first of two" } },
            { type: "tool-approval-request", approvalId: "twice", toolCallId: "repeated" },
            { type: "tool-call", id: "other", name: "erase", params: { id: "replaced" } },
            { type: "tool-approval-request", approvalId: "twice", toolCallId: "other" },
            { type: "tool-call", id: "repeated", name: "erase", params: { id: "second of two" } },
            { type: "tool-call", id: "done", name: "erase", params: { id: "already ran" } },
            { type: "tool-approval-request", approvalId: "ran", toolCallId: "done" },
            { type: "tool-approval-request", approvalId: "callless", toolCallId: "missing" },
            { type: "tool-call", id: "plain", name: "erase", params: { id: "plain" } },
            { type: "tool-approval-request", approvalId: "plain", toolCallId: "plain" },
            { type: "tool-approval-request", approvalId: "last", toolCallId: "repeated" },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              id: "done",
              name: "erase",
              isFailure: false,
              result: "erased already ran",
            },
          ],
        },
      ]);

      const listed = ActionToolkit.openApprovals(yield* Ref.get(chat.history));

      yield* chat
        .generateText({
          prompt: [
            {
              role: "tool",
              content: listed.map(({ approvalId }) => ({
                type: "tool-approval-response" as const,
                approvalId,
                approved: true,
              })),
            },
          ],
          toolkit,
        })
        .pipe(Effect.provideService(LanguageModel.LanguageModel, model), Effect.provide(layer));

      expect(listed.map(({ params }) => params)).toEqual(erased.map((id) => ({ id })));
      expect(erased).toEqual(["replaced", "plain", "second of two"]);
      expect(ActionToolkit.openApprovals(yield* Ref.get(chat.history))).toEqual([]);
    }),
);
