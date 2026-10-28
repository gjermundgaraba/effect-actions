import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Clock, Effect, Layer, Option, Schema } from "effect";

import { deleted } from "./batches.js";

const keptPrefix = "effect-actions/idempotency/";

const hour = 60 * 60 * 1000;

const page = 128;

const keptOf = Schema.decodeUnknownOption(Action.Idempotency.Kept);

export const layerIdempotency = (
  state: DurableObjectState
): Layer.Layer<Action.Idempotency> =>
  Layer.sync(Action.Idempotency)(() => {
    let prunedAt = -Infinity;

    const pruneHourlyOnWrite = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      if (now - prunedAt < hour) {
        return;
      }

      prunedAt = now;

      let after: string | undefined;

      do {
        const options = {
          prefix: keptPrefix,
          limit: page,
          ...(after === undefined ? {} : { startAfter: after }),
        };

        const listed = [
          ...(yield* Effect.promise(
            async () => await state.storage.list(options)
          )),
        ];

        yield* deleted(
          state.storage,
          listed.flatMap(([key, value]) =>
            Option.exists(
              keptOf(value),
              ({ at }) => at + Action.Idempotency.keptFor <= now
            )
              ? [key]
              : []
          )
        );

        after = listed.length === page ? listed.at(-1)?.[0] : undefined;
      } while (after !== undefined);
    });

    return Action.Idempotency.of({
      get: (id) =>
        Effect.map(
          Effect.promise(
            async () => await state.storage.get(`${keptPrefix}${id}`)
          ),
          (stored) => Option.getOrUndefined(keptOf(stored))
        ),
      set: (id, kept) =>
        Effect.andThen(
          Effect.promise(async () => {
            await state.storage.put(`${keptPrefix}${id}`, kept);
          }),
          pruneHourlyOnWrite
        ),
    });
  });
