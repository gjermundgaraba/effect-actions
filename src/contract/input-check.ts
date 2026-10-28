import { Context, Effect } from "effect";

import type * as Action from "./Action.js";
import type { Forbidden } from "./errors.js";
import type * as Event from "./Event.js";

/**
 * A check every call and every subscription runs on its decoded input, on every surface, once the
 * surface has verified its caller and before its authorizer: what a host provides, as a Durable
 * Object refuses an input naming another object, to refuse an input it does not serve. Defaults
 * to none.
 *
 * **Gotchas**
 *
 * - Provide it to the layer graph the surfaces are built in, as `Layer.succeed(Action.InputCheck)(check)`: provided per request, it misses a socket's later calls.
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
