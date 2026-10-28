import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Context, Effect, Layer } from "effect";
import { Chat, Tool } from "effect/ai";
import type { LanguageModel, Prompt } from "effect/ai";

import type { Member } from "./identity/Identity.js";
import { demoMembers } from "./identity/members.js";
import { Permissions } from "./identity/permissions.js";
import { demoTasksFile } from "./platform/tasks-file.js";
import { scripted } from "./scripted.js";
import { actingFor, layer, toolkit } from "./toolkit.js";

type Response = LanguageModel.GenerateTextResponse<
  typeof toolkit.tools,
  "opaque"
>;

const report = (member: Member) => (response: Response) => {
  const waiting = new Set(
    response.content.flatMap((part) =>
      part.type === "tool-approval-request" ? [part.toolCallId] : []
    )
  );

  return Console.log(
    [
      `As ${member.id}:`,
      ...response.toolResults.map(
        ({ name, encodedResult }) =>
          `  ${name} -> ${JSON.stringify(encodedResult)}`
      ),
      ...response.toolCalls.flatMap(({ id, name, params }) => {
        const title = Context.getOrElse(
          toolkit.tools[name].annotations,
          Tool.Title,
          () => name
        );

        return waiting.has(id)
          ? [`  ${title} ${JSON.stringify(params)} waits for approval`]
          : [];
      }),
      ...(response.text === "" ? [] : [`  "${response.text}"`]),
    ].join("\n")
  );
};

const turn = (chat: Chat.Chat, member: Member, prompt: Prompt.RawInput) =>
  chat
    .generateText({ prompt, toolkit })
    .pipe(actingFor(member), Effect.tap(report(member)));

const conversations = Effect.gen(function* () {
  const withAda = yield* Chat.empty;

  const asked = yield* turn(
    withAda,
    demoMembers.ada,
    "Add the venue for me, invitations for Grace."
  );

  yield* turn(withAda, demoMembers.ada, [
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
  ]);

  yield* turn(
    yield* Chat.empty,
    demoMembers.guest,
    "What is there to do? Add lunch for me."
  );
});

const adding = (id: string, title: string, assignee: string) =>
  ({
    type: "tool-call",
    id,
    name: "addTask",
    params: { title, assignee },
  }) as const;

const demoModel = scripted(
  [
    adding("1", "Book the venue", "ada"),
    adding("2", "Send invitations", "grace"),
  ],
  [{ type: "text", text: "Both tasks are on the list." }],
  [
    { type: "tool-call", id: "3", name: "listTasks", params: {} },
    adding("4", "Lunch", "guest"),
  ]
);

conversations.pipe(
  Effect.provide(
    Layer.mergeAll(
      demoModel,
      layer.pipe(Layer.provide([demoTasksFile, Permissions.layerMemory]))
    ).pipe(Layer.provideMerge(NodeServices.layer))
  ),
  NodeRuntime.runMain()
);
