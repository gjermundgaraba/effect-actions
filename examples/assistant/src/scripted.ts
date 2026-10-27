import { Effect, Layer, Ref, Stream } from "effect";
import { LanguageModel } from "effect/ai";
import type { Response } from "effect/ai";

// DEMO ONLY: a model that needs no API key. It answers its first request with the first reply
// it was given, its second with the second, whatever the prompt says, and with nothing once
// they run out. It stands exactly where a provider's model layer goes, such as
// `OpenAiLanguageModel.model(...)` of `@effect/ai-openai`.
export const scripted = (
  ...replies: ReadonlyArray<readonly Response.PartEncoded[]>
) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    Effect.gen(function* () {
      const answered = yield* Ref.make(0);

      return yield* LanguageModel.make({
        generateText: () =>
          Effect.map(
            Ref.getAndUpdate(answered, (count) => count + 1),
            (count) => [...(replies[count] ?? [])]
          ),
        streamText: () => Stream.empty,
      });
    })
  );
