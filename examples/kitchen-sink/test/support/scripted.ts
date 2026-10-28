import { Effect, Layer, Ref, Stream } from "effect";
import { AiError, LanguageModel } from "effect/ai";
import type { Response } from "effect/ai";

type Reply = readonly Response.PartEncoded[];

export const scripted = (
  ...replies: ReadonlyArray<Reply | Effect.Effect<Reply, AiError.AiError>>
) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    Effect.gen(function* () {
      const answered = yield* Ref.make(0);

      return yield* LanguageModel.make({
        generateText: () =>
          Effect.flatMap(
            Ref.getAndUpdate(answered, (count) => count + 1),
            (count) => {
              const reply = replies[count] ?? [];

              return Effect.isEffect(reply)
                ? Effect.map(reply, (parts) => [...parts])
                : Effect.succeed([...reply]);
            }
          ),
        streamText: () => Stream.empty,
      });
    })
  );

export const down: Effect.Effect<never, AiError.AiError> = Effect.fail(
  AiError.make({
    module: "scripted",
    method: "generateText",
    reason: new AiError.UnknownError({ description: "The provider is down." }),
  })
);
