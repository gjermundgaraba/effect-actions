import { Effect, Layer, Ref, Stream } from "effect";
import { AiError, LanguageModel, type Response } from "effect/ai";

type Reply = ReadonlyArray<Response.PartEncoded>;

// A model for a test: it answers its first request with the first reply it was given, its
// second with the second, whatever the prompt says. A reply is the parts a provider sends, or
// an Effect that makes them: `down` to fail as a provider that is down does, or one that waits.
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
            },
          ),
        streamText: () => Stream.empty,
      });
    }),
  );

export const down: Effect.Effect<never, AiError.AiError> = Effect.fail(
  AiError.make({
    module: "scripted",
    method: "generateText",
    reason: new AiError.UnknownError({ description: "The provider is down." }),
  }),
);
