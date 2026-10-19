import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Layer } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { demoModel } from "./assistant/demo-model.js";
import { CurrentMember } from "./identity/Identity.js";
import { members } from "./identity/members.js";
import { layer, triage } from "./issues/assistant.js";
import { issues } from "./issues/handlers.js";
import { IssueStore } from "./issues/store.js";
import { limiter } from "./memory.js";

// Entrypoint: `node --import tsx examples/kitchen-sink/src/agent.ts`.
// The assistant as a local program: a model calling the issue actions as tools, in process.
// The server serves the same tools behind a route, a turn per request: assistant/handlers.ts.

const program = Effect.gen(function* () {
  // Code of your own calls the implementation typed, with `Action.client`: the same decoding,
  // `authorize` and handler, with no transport. The store is memory, so file an issue first.
  const tracker = yield* Action.client(issues);

  yield* tracker.createIssue({ title: "Crash on save", body: "Stack trace attached." });

  const turn = yield* triage("Close what is done.");

  // The read ran: its result is here. The write did not: it waits for the member's approval,
  // which a host answers in the next turn, as assistant/handlers.ts does.
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
  // DEMO ONLY: a real host names whoever asked.
  Effect.provideService(CurrentMember, members.ada),
  Effect.provide(layer.pipe(Layer.provideMerge(Layer.merge(IssueStore.layerMemory, limiter)))),
  // DEMO ONLY: a scripted model. A real one is a provider's layer, in its place.
  Effect.provide(demoModel),
  NodeRuntime.runMain,
);
