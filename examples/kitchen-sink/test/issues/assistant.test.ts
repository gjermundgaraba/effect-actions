import { describe, expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Effect, Layer, Stream } from "effect";
import { LanguageModel } from "effect/ai";

import { CurrentMember } from "../../src/identity/Identity.js";
import { demoMembers } from "../../src/identity/members.js";
import { layer, toolkit, triage } from "../../src/issues/assistant.js";
import { issues } from "../../src/issues/handlers.js";
import { memory } from "../../src/memory.js";

const model = LanguageModel.make({
  generateText: () =>
    Effect.succeed([
      {
        type: "tool-call",
        id: "1",
        name: "getIssue",
        params: { id: "ACME-1" },
      },
      {
        type: "tool-call",
        id: "2",
        name: "closeIssue",
        params: { id: "ACME-1" },
      },
    ] as const),
  streamText: () => Stream.empty,
});

const asAda = Effect.provideService(CurrentMember, demoMembers.ada);

const services = layer.pipe(Layer.provideMerge(memory));

describe("the assistant's tools", () => {
  it.effect("runs a model's read and holds its write for approval", () =>
    Effect.gen(function* () {
      const tracker = yield* Action.client(issues);

      yield* tracker.createIssue({ title: "Crash", body: "" }).pipe(asAda);

      const turn = yield* triage("Close what is done.").pipe(
        asAda,
        Effect.provideServiceEffect(LanguageModel.LanguageModel, model)
      );

      expect(turn.toolResults.map(({ name }) => name)).toStrictEqual([
        "getIssue",
      ]);
      expect(
        turn.content.flatMap((part) =>
          part.type === "tool-approval-request" ? [part.toolCallId] : []
        )
      ).toStrictEqual(["2"]);
      expect(
        yield* tracker.getIssue({ id: "ACME-1" }).pipe(asAda)
      ).toMatchObject({
        status: "open",
      });
    }).pipe(Effect.provide(services))
  );

  it.effect(
    "offers the listed actions alone, and runs `authorize` for a call made by hand",
    () =>
      Effect.gen(function* () {
        const tools = yield* toolkit;

        expect(Object.keys(tools.tools)).toStrictEqual([
          "listIssues",
          "getIssue",
          "commentOnIssue",
          "closeIssue",
        ]);

        const refused = yield* tools
          .handle("closeIssue", { id: "ACME-1" })
          .pipe(
            Effect.flatMap(Stream.runCollect),
            Effect.provideService(CurrentMember, demoMembers.linus)
          );

        expect(
          refused.map(({ isFailure, result }) => [isFailure, result])
        ).toStrictEqual([
          [true, new Action.Forbidden({ scopes: ["issues:write"] })],
        ]);
      }).pipe(Effect.provide(services))
  );
});
