import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Authentication from "@gjermundgaraba/effect-actions/Authentication";
import { Effect, Redacted } from "effect";

import { OperatorKey } from "./Admin.js";
import type { KeyOperator } from "./Admin.js";
import { keys } from "./keys.js";

// Typed to return a `KeyOperator`, never the `Operator` union (Admin.ts says why). The verifier
// receives what its scheme decodes, the header's value, and needs no startup service, so it is
// passed as it is.
const verify = (
  key: Redacted.Redacted
): Effect.Effect<KeyOperator, Action.Unauthenticated> =>
  Effect.fromNullishOr(keys.get(Redacted.value(key))).pipe(
    Effect.mapError(
      () => new Action.Unauthenticated({ message: "Unknown operator key." })
    )
  );

// Server only: `OperatorKey`'s provider, which the admin port's routes require.
export const authenticateOperator = Authentication.layer(OperatorKey, verify);
