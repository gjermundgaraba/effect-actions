import { Effect, Option } from "effect";
import { LanguageModel } from "effect/ai";
import * as ActionToolkit from "../src/ActionToolkit.js";
import { type Actor, CurrentActor } from "./authorization.js";
import { double, userActions } from "./handlers.js";

// A model's writes wait for their caller's approval, except a rename of the caller itself:
// `call.name` narrows `call.input` across both implementations. Without a caller, it asks.
export const { toolkit, layer } = ActionToolkit.make([userActions, double], {
  needsApproval: (call) =>
    !call.action.readOnly &&
    Effect.map(
      Effect.serviceOption(CurrentActor),
      Option.match({
        onNone: () => true,
        onSome: ({ id }) => call.name !== "renameUser" || call.input.id !== id,
      }),
    ),
});

// One turn: the caller is provided around it, for the approval, `authorize` and the handlers.
export const chat = (actor: Actor, prompt: string) =>
  LanguageModel.generateText({ prompt, toolkit }).pipe(Effect.provideService(CurrentActor, actor));
