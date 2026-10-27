import { Deferred, Effect, Schema, Stream } from "effect";

import * as Action from "../../../src/contract/Action.js";

export const Count = Action.make("count", {
  description: "Count until the caller stops reading.",
  success: Action.Stream(Schema.Finite),
  readOnly: true,
  caller: Action.Anyone,
});

export const countsReleasing = (released: Deferred.Deferred<undefined>) =>
  Action.implement(Count, () =>
    Stream.concat(
      Stream.fromEffect(
        Effect.as(
          Effect.addFinalizer(() => Deferred.succeed(released, undefined)),
          0
        )
      ),
      Stream.iterate(1, (n) => n + 1)
    )
  );
