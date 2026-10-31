import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";
import { Chat, LanguageModel } from "effect/ai";
import type { Prompt } from "effect/ai";
import { Base64 } from "effect/encoding";

import * as Action from "../../src/contract/Action.js";
import * as ActionToolkit from "../../src/toolkit/ActionToolkit.js";

const read = {
  description: "Looks",
  readOnly: true,
  caller: Action.Anyone,
} as const;

const png = new Uint8Array([137, 80, 78, 71]);

const jpeg = new Uint8Array([255, 216, 255]);

const image = { data: png, mimeType: "image/png" };

const photo = { data: jpeg, mimeType: "image/jpeg" };

const filePartOf = ({ data, mimeType }: typeof Action.Image.Type) => ({
  type: "file",
  mediaType: mimeType,
  data,
});

const textPartOf = (json: Schema.Json) => ({
  type: "text",
  text: JSON.stringify(json),
});

const Shot = Action.make("shot", {
  ...read,
  success: { caption: Schema.String, image: Action.Image },
});

const Album = Action.make("album", {
  ...read,
  success: Schema.Array(Action.Image),
});

const Framed = Action.make("framed", {
  ...read,
  success: { image: Action.Image },
});

const Caption = Action.make("caption", {
  ...read,
  success: { caption: Schema.String },
});

const Nested = Action.make("nested", {
  ...read,
  success: { screen: Schema.Struct({ image: Action.Image }) },
});

const Render = Action.make("render", {
  ...read,
  success: { caption: Schema.String, image: Action.Image },
  progress: { percent: Schema.Finite },
});

const tools = ActionToolkit.make(
  Action.implement([Shot, Album, Framed, Caption, Nested, Render], {
    shot: () => Effect.succeed({ caption: "bed", image }),
    album: () => Effect.succeed([image, photo]),
    framed: () => Effect.succeed({ image }),
    caption: () => Effect.succeed({ caption: "bed" }),
    nested: () => Effect.succeed({ screen: { image } }),
    render: (_input, { progress }) =>
      Effect.as(progress({ percent: 50 }), { caption: "bed", image }),
  })
);

const resultsOf = (name: keyof typeof tools.toolkit.tools) =>
  Effect.flatMap(tools.toolkit, (toolkit) =>
    Effect.flatMap(toolkit.handle(name, {}), Stream.runCollect)
  ).pipe(Effect.provide(tools.layer));

describe("a toolkit tool of an action answering media", () => {
  it.effect(
    "sends the model a struct success's other fields as one JSON text part, then its image as a file part, and the application the typed success",
    () =>
      Effect.gen(function* () {
        const [returned] = yield* resultsOf("shot");

        expect(returned?.modelOutput).toMatchObject([
          textPartOf({ caption: "bed" }),
          filePartOf(image),
        ]);
        expect(returned?.result).toStrictEqual({ caption: "bed", image });
        expect(returned?.encodedResult).toStrictEqual({
          caption: "bed",
          image: { data: Base64.encode(png), mimeType: "image/png" },
        });
      })
  );

  it.effect(
    "sends an array success as one file part per image, and a success of media fields alone without a text part",
    () =>
      Effect.gen(function* () {
        const [album] = yield* resultsOf("album");
        const [framed] = yield* resultsOf("framed");

        expect(album?.modelOutput).toMatchObject([
          filePartOf(image),
          filePartOf(photo),
        ]);
        expect(framed?.modelOutput).toMatchObject([filePartOf(image)]);
      })
  );

  it.effect(
    "gives no model output to a success without media, or with an image only where none is lifted, which stays in the JSON",
    () =>
      Effect.gen(function* () {
        const [caption] = yield* resultsOf("caption");
        const [nested] = yield* resultsOf("nested");

        expect(caption).toMatchObject({
          isFailure: false,
          result: { caption: "bed" },
        });
        expect(caption?.modelOutput).toBeUndefined();
        expect(nested?.encodedResult).toStrictEqual({
          screen: {
            image: { data: Base64.encode(png), mimeType: "image/png" },
          },
        });
        expect(nested?.modelOutput).toBeUndefined();
      })
  );

  it.effect(
    "gives a progress value no model output, and the success its parts",
    () =>
      Effect.gen(function* () {
        const results = yield* resultsOf("render");

        expect(
          results.map(({ preliminary, result, modelOutput }) => ({
            preliminary,
            result,
            modelOutput,
          }))
        ).toMatchObject([
          {
            preliminary: true,
            result: { _tag: "Progress", value: { percent: 50 } },
            modelOutput: undefined,
          },
          {
            preliminary: false,
            result: { caption: "bed", image },
            modelOutput: [textPartOf({ caption: "bed" }), filePartOf(image)],
          },
        ]);
      })
  );

  it.effect(
    "carries the parts into the next turn's prompt, in the tool result beside its JSON",
    () =>
      Effect.gen(function* () {
        const prompts: Prompt.Prompt[] = [];

        const model = yield* LanguageModel.make({
          generateText: ({ prompt }) =>
            Effect.sync(() => {
              prompts.push(prompt);

              return prompts.length === 1
                ? [
                    {
                      type: "tool-call" as const,
                      id: "1",
                      name: "shot",
                      params: {},
                    },
                  ]
                : [{ type: "text" as const, text: "A bed." }];
            }),
          streamText: () => Stream.empty,
        });

        const chat = yield* Chat.empty;

        const turn = (prompt: string) =>
          chat
            .generateText({ prompt, toolkit: tools.toolkit })
            .pipe(
              Effect.provideService(LanguageModel.LanguageModel, model),
              Effect.provide(tools.layer)
            );

        const asked = yield* turn("Look at the bed.");

        yield* turn("Describe it.");

        expect(asked.toolResults.map(({ result }) => result)).toStrictEqual([
          { caption: "bed", image },
        ]);
        expect(
          prompts[1]?.content.flatMap((message) =>
            message.role === "tool" ? message.content : []
          )
        ).toMatchObject([
          {
            type: "tool-result",
            name: "shot",
            result: {
              caption: "bed",
              image: { data: Base64.encode(png), mimeType: "image/png" },
            },
            modelOutput: [textPartOf({ caption: "bed" }), filePartOf(image)],
          },
        ]);
      })
  );
});
