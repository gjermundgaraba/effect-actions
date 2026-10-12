import { Layer, Effect, Stream } from "effect";
import { LanguageModel } from "effect/ai";

// DEMO ONLY: a model that needs no API key. Asked by a person, it lists the open issues and
// closes ACME-1; once its tools have answered, it says so. A real one is a provider's layer,
// such as `AnthropicLanguageModel.model(...)`, provided in its place.
export const demoModel = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: ({ prompt }) =>
      Effect.succeed(
        prompt.content.at(-1)?.role === "tool"
          ? [{ type: "text", text: "Done." } as const]
          : [
              {
                type: "tool-call",
                id: "1",
                name: "listIssues",
                params: { status: "open" },
              } as const,
              { type: "tool-call", id: "2", name: "closeIssue", params: { id: "ACME-1" } } as const,
            ],
      ),
    streamText: () => Stream.empty,
  }),
);
