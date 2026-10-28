import { NodeRuntime } from "@effect/platform-node";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Console, Effect, Layer } from "effect";

import { demoModel } from "./assistant/demo-model.js";
import { CurrentMember } from "./identity/Identity.js";
import { demoMembers } from "./identity/members.js";
import { layer, triage } from "./issues/assistant.js";
import { issues } from "./issues/handlers.js";
import { IssueStore } from "./issues/store.js";
import { limiter } from "./memory.js";

const program = Effect.gen(function* () {
  const tracker = yield* Action.client(issues);

  yield* tracker.createIssue({
    title: "Crash on save",
    body: "Stack trace attached.",
  });

  const turn = yield* triage("Close what is done.");

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
  Effect.provideService(CurrentMember, demoMembers.ada),
  Effect.provide(
    layer.pipe(
      Layer.provideMerge(Layer.merge(IssueStore.layerMemory, limiter)),
      Layer.provideMerge(demoModel)
    )
  ),
  NodeRuntime.runMain()
);
