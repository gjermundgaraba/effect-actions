import { Layer, Effect, Stream } from "effect";
import { LanguageModel } from "effect/ai";

// DEMO ONLY: a model that needs no API key. Asked by a person, it lists the open issues and
// closes ACME-1; once its tools have answered, it says so. A real one is a provider's layer,
// such as `AnthropicLanguageModel.model(...)`, provided in its place. Each call has an id of
// its own, as a provider's has: Effect finds the call an approval is about by that id, so one
// used twice in a conversation would run another call than the member was shown, or none.
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
