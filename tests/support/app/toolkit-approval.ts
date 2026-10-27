import * as ActionToolkit from "@gjermundgaraba/effect-actions/ActionToolkit";
import { Effect, Option } from "effect";
import { LanguageModel } from "effect/ai";

import { CurrentActor } from "./authorization.js";
import type { Actor } from "./authorization.js";
import { double, userActions } from "./handlers.js";

export const { toolkit, layer } = ActionToolkit.make([userActions, double], {
  needsApproval: (call) =>
    !call.action.readOnly &&
    Effect.map(
      Effect.serviceOption(CurrentActor),
      Option.match({
        onNone: () => true,
        onSome: ({ id }) => call.name !== "renameUser" || call.input.id !== id,
      })
    ),
});

export const chat = (actor: Actor, prompt: string) =>
  LanguageModel.generateText({ prompt, toolkit }).pipe(
    Effect.provideService(CurrentActor, actor)
  );
