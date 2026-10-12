import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Layer, Stream } from "effect";
import { LanguageModel } from "effect/ai";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { CurrentMember } from "./identity/Identity.js";
import { members } from "./identity/members.js";
import { layer, triage } from "./issues/assistant.js";
import { issues } from "./issues/handlers.js";
import { IssueStore } from "./issues/store.js";
import { limiter } from "./memory.js";

// Entrypoint: `node --import tsx examples/kitchen-sink/src/agent.ts`.
// The assistant as a local program: a model calling the issue actions as tools, in process.

// DEMO ONLY: a scripted model that always asks for the same two tools. A real one is a
// provider's layer, such as `AnthropicLanguageModel.layer`.
const scripted = LanguageModel.make({
  generateText: () =>
    Effect.succeed([
      { type: "tool-call", id: "1", name: "listIssues", params: { status: "open" } },
      { type: "tool-call", id: "2", name: "closeIssue", params: { id: "ACME-1" } },
    ] as const),
  streamText: () => Stream.empty,
});

const program = Effect.gen(function* () {
  // Code of your own calls the implementation typed, with `Action.client`: the same decoding,
  // `authorize` and handler, with no transport. The store is memory, so file an issue first.
  const tracker = yield* Action.client(issues);

  yield* tracker.createIssue({ title: "Crash on save", body: "Stack trace attached." });

  const turn = yield* triage("Close what is done.");

  // The read ran: its result is here. The write did not: it waits for the member's approval,
  // which the host answers in the next turn with a `tool-approval-response` prompt part.
  for (const { name, encodedResult } of turn.toolResults) {
    yield* Console.log(`${name} answered`, encodedResult);
  }

  for (const part of turn.content) {
    if (part.type === "tool-approval-request") {
      yield* Console.log(`Call ${part.toolCallId} waits for approval.`);
    }
  }
});

program.pipe(
  Effect.scoped,
  // No remote caller: this host names the member the assistant acts for, around the turn.
  Effect.provideService(CurrentMember, members.ada),
  // Startup services only. An identity provided here would be every caller's.
  Effect.provide(layer.pipe(Layer.provideMerge(Layer.merge(IssueStore.layerMemory, limiter)))),
  Effect.provideServiceEffect(LanguageModel.LanguageModel, scripted),
  NodeRuntime.runMain,
);
