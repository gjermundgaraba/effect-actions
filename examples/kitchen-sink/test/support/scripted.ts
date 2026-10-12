import { Effect, Layer, Ref, Stream } from "effect";
import { AiError, LanguageModel, type Response } from "effect/ai";

// A model for a test: it answers its first request with the first reply it was given, its
// second with the second, whatever the prompt says, and fails where a reply is `"fails"`, as a
// provider that is down does.
export const scripted = (
  ...replies: ReadonlyArray<ReadonlyArray<Response.PartEncoded> | "fails">
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

              return reply === "fails"
                ? Effect.fail(
                    AiError.make({
                      module: "scripted",
                      method: "generateText",
                      reason: new AiError.UnknownError({ description: "The provider is down." }),
                    }),
                  )
                : Effect.succeed([...reply]);
            },
          ),
        streamText: () => Stream.empty,
      });
    }),
  );
