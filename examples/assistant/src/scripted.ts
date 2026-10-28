import { Effect, Layer, Ref, Stream } from "effect";
import { LanguageModel } from "effect/ai";
import type { Response } from "effect/ai";

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
