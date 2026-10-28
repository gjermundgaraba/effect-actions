import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { Effect, Redacted } from "effect";

import { OperatorKey } from "./Admin.js";
import type { KeyOperator } from "./Admin.js";
import { demoOperatorKeys } from "./keys.js";

const verify = (
  key: Redacted.Redacted
): Effect.Effect<KeyOperator, Action.Unauthenticated> =>
  Effect.fromNullishOr(demoOperatorKeys.get(Redacted.value(key))).pipe(
    Effect.mapError(
      () => new Action.Unauthenticated({ message: "Unknown operator key." })
    )
  );

export const authenticateOperator = Authentication.layer(OperatorKey, verify);
