import { Layer, Effect, Stream } from "effect";
import { LanguageModel } from "effect/ai";

export const demoModel = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: ({ prompt }) =>
      Effect.sync(() =>
        prompt.content.at(-1)?.role === "tool"
          ? [{ type: "text", text: "Done." } as const]
          : [
              {
                type: "tool-call",
                id: crypto.randomUUID(),
                name: "listIssues",
                params: { status: "open" },
              } as const,
              {
                type: "tool-call",
                id: crypto.randomUUID(),
                name: "closeIssue",
                params: { id: "ACME-1" },
              } as const,
            ]
      ),
    streamText: () => Stream.empty,
  })
);
