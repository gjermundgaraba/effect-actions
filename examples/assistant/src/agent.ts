import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Context, Effect, Layer } from "effect";
import { Chat, type LanguageModel, type Prompt, Tool } from "effect/ai";
import type { Member } from "./identity/Identity.js";
import { members } from "./identity/members.js";
import { Permissions } from "./identity/permissions.js";
import { scripted } from "./scripted.js";
import { tasksFile } from "./platform/tasks-file.js";
import { actingFor, layer, toolkit } from "./toolkit.js";

// Entrypoint: `node --import tsx examples/assistant/src/agent.ts`.
// A model working on the team's tasks with tools that run in this process: no server and no
// port. Every tool call passes through the same `authorize` and handlers as the commands.

// What a turn answers with: its text, the calls the model made and what they returned.
type Response = LanguageModel.GenerateTextResponse<typeof toolkit.tools, "opaque">;

// Printing only. A refusal or a declared error is a result too: JSON the model reads and may
// act on.
const report = (member: Member) => (response: Response) => {
  const waiting = response.content.flatMap((part) =>
    part.type === "tool-approval-request" ? [part.toolCallId] : [],
  );

  return Console.log(
    [
      `As ${member.id}:`,
      ...response.toolResults.map(
        ({ name, encodedResult }) => `  ${name} -> ${JSON.stringify(encodedResult)}`,
      ),
      ...response.toolCalls.flatMap(({ id, name, params }) => {
        const title = Context.getOrElse(toolkit.tools[name].annotations, Tool.Title, () => name);

        return waiting.includes(id)
          ? [`  ${title} ${JSON.stringify(params)} waits for approval`]
          : [];
      }),
      ...(response.text === "" ? [] : [`  "${response.text}"`]),
    ].join("\n"),
  );
};

// One turn of a conversation: the model reads the prompt and may call tools. The member is
// provided around the whole turn, so the approval rule, `authorize` and the handlers of every
// call in it see that member.
const turn = (chat: Chat.Chat, member: Member, prompt: Prompt.RawInput) =>
  chat.generateText({ prompt, toolkit }).pipe(actingFor(member), Effect.tap(report(member)));

const conversations = Effect.gen(function* () {
  // A `Chat` keeps the conversation's history, and approval depends on it: an answer is matched
  // to its request by `approvalId` in the prompt. The answer alone, sent through a bare
  // `LanguageModel.generateText`, runs nothing. Without a `Chat`, send again the assistant
  // message holding the call and its request, before the answer.
  const withAda = yield* Chat.empty;

  // Ada's own task is added at once. The task for Grace is not run: the turn ends with a
  // request for approval in place of that call's result.
  const asked = yield* turn(withAda, members.ada, "Add the venue for me, invitations for Grace.");

  // A real host shows each request to the person and waits. Their answers start the next turn,
  // in which an approved call runs before the model is asked again. It runs as whoever that
  // turn runs as, so the host provides the member who was asked: Ada still.
  yield* turn(withAda, members.ada, [
    {
      role: "tool",
      content: asked.content.flatMap((part) =>
        part.type === "tool-approval-request"
          ? [{ type: "tool-approval-response", approvalId: part.approvalId, approved: true }]
          : [],
      ),
    },
  ]);

  // The same toolkit, another member. The guest may read, so the write comes back refused.
  yield* turn(yield* Chat.empty, members.guest, "What is there to do? Add lunch for me.");
});

const adding = (id: string, title: string, assignee: string) =>
  ({ type: "tool-call", id, name: "addTask", params: { title, assignee } }) as const;

// DEMO ONLY: what the model answers, request by request, so this runs without an API key.
const model = scripted(
  [adding("1", "Book the venue", "ada"), adding("2", "Send invitations", "grace")],
  [{ type: "text", text: "Both tasks are on the list." }],
  [{ type: "tool-call", id: "3", name: "listTasks", params: {} }, adding("4", "Lunch", "guest")],
);

conversations.pipe(
  // A real `LanguageModel` plugs in here: the layer of a provider's model, with the layer of
  // that provider's client, in place of the scripted one. Nothing below this line changes.
  Effect.provide(model),
  // Startup services only: where tasks and permissions are kept. Never a caller.
  Effect.provide(layer.pipe(Layer.provide([tasksFile, Permissions.layerMemory]))),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
