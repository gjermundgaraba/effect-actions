import { Context, Effect } from "effect";

import type * as Action from "./Action.js";
import type { Forbidden } from "./errors.js";
import type * as Event from "./Event.js";

/**
 * A check every call and every subscription runs on its decoded input, on every surface, once the
 * surface has verified its caller and before its authorizer: what `ActionEntity.layer` provides
 * around each call, refusing an input whose key names another entity. Defaults to none.
 */
export const InputCheck = Context.Reference<
  (
    contract: Action.Any | Event.Any,
    input: Action.Any["input"]["Type"]
  ) => Effect.Effect<void, Forbidden>
>("effect-actions/Action/InputCheck", {
  defaultValue: () => () => Effect.void,
});

export const checkInput = (
  contract: Action.Any | Event.Any,
  input: Action.Any["input"]["Type"]
) =>
  Effect.flatMap(Effect.service(InputCheck), (check) => check(contract, input));
