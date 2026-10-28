import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { Chat, LanguageModel } from "effect/ai";

import type { Member } from "../src/identity/Identity.js";
import { demoMembers } from "../src/identity/members.js";
import { Permissions } from "../src/identity/permissions.js";
import { scripted } from "../src/scripted.js";
import { TaskStore } from "../src/tasks/store.js";
import { actingFor, layer, toolkit } from "../src/toolkit.js";

const tools = layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(TaskStore.layerMemory, Permissions.layerMemory)
  )
);

const adding = (id: string, assignee: string) =>
  ({
    type: "tool-call",
    id,
    name: "addTask",
    params: { title: "Order lunch", assignee },
  }) as const;

const outcome = (
  response: LanguageModel.GenerateTextResponse<typeof toolkit.tools, "opaque">
) => ({
  ran: response.toolResults.map(({ id }) => id),
  waiting: response.content.flatMap((part) =>
    part.type === "tool-approval-request" ? [part.toolCallId] : []
  ),
});

const plan = (member: Member) =>
  LanguageModel.generateText({
    prompt: "Plan the launch.",
    toolkit,
  }).pipe(
    actingFor(member),
    Effect.map(outcome),
    Effect.provide(
      scripted([adding("for ada", "ada"), adding("for grace", "grace")])
    )
  );

describe("the toolkit", () => {
  it.effect("runs each call as the member provided around it", () =>
    Effect.gen(function* () {
      const { handle } = yield* toolkit;

      const add = handle("addTask", {
        title: "Order lunch",
        assignee: "guest",
      }).pipe(Effect.flatMap(Stream.runCollect));

      expect(yield* add.pipe(actingFor(demoMembers.guest))).toMatchObject([
        { isFailure: true, result: { message: "Requires tasks:write." } },
      ]);
      expect(yield* add.pipe(actingFor(demoMembers.ada))).toMatchObject([
        { isFailure: false, result: { id: "1", addedBy: "ada" } },
      ]);
    }).pipe(Effect.provide(tools))
  );

  it.effect(
    "asks for approval before a model adds to a list that is not its caller's",
    () =>
      Effect.gen(function* () {
        expect(yield* plan(demoMembers.ada)).toStrictEqual({
          ran: ["for ada"],
          waiting: ["for grace"],
        });
        expect(yield* plan(demoMembers.grace)).toStrictEqual({
          ran: ["for grace"],
          waiting: ["for ada"],
        });

        const store = yield* TaskStore;

        expect(
          (yield* store.list(undefined)).map(({ addedBy }) => addedBy)
        ).toStrictEqual(["ada", "grace"]);
      }).pipe(Effect.provide(tools))
  );

  it.effect(
    "authorizes an approved call too: approval lets no one do what they may not",
    () =>
      Effect.gen(function* () {
        const chat = yield* Chat.empty;

        const asked = yield* chat
          .generateText({ prompt: "Add lunch to Ada's list.", toolkit })
          .pipe(actingFor(demoMembers.guest));

        expect(outcome(asked)).toStrictEqual({ ran: [], waiting: ["for ada"] });

        const answered = yield* chat
          .generateText({
            prompt: [
              {
                role: "tool",
                content: asked.content.flatMap((part) =>
                  part.type === "tool-approval-request"
                    ? [
                        {
                          type: "tool-approval-response",
                          approvalId: part.approvalId,
                          approved: true,
                        },
                      ]
                    : []
                ),
              },
            ],
            toolkit,
          })
          .pipe(actingFor(demoMembers.guest));

        expect(answered.toolResults).toMatchObject([
          {
            id: "for ada",
            isFailure: true,
            result: { message: "Requires tasks:write." },
          },
        ]);

        const store = yield* TaskStore;

        expect(yield* store.list(undefined)).toStrictEqual([]);
      }).pipe(
        Effect.provide(
          scripted([adding("for ada", "ada")]).pipe(Layer.provideMerge(tools))
        )
      )
  );
});
