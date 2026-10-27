import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Clock, Effect, Layer, Option, Schema } from "effect";

import { deleted } from "./batches.js";

/** Where the object's kept answers live, one key per action, caller's principal and idempotency key. */
const keptPrefix = "effect-actions/idempotency/";

const hour = 60 * 60 * 1000;

const page = 128;

const keptOf = Schema.decodeUnknownOption(Action.Idempotency.Kept);

/**
 * `Action.Idempotency` over the object's storage: each answer kept 24 hours, through
 * hibernation, eviction and deployments, and deleted once its day is past as a later one is kept,
 * at most once an hour, so an object given no further key keeps its last day's answers.
 */
export const layerIdempotency = (
  state: DurableObjectState
): Layer.Layer<Action.Idempotency> =>
  Layer.sync(Action.Idempotency)(() => {
    let prunedAt = -Infinity;

    // Why: on a write, never on the alarm, so an object nobody calls is never woken to delete
    // answers nobody reads, and an hour apart, as each prune lists every kept answer. It lists
    // them a page at a time: a busy object's day of answers, each its outcome's JSON, is too many
    // to hold at once. An entry that does not decode is left, as `get` reads it as nothing kept
    // and only this layer writes under the prefix.
    const prune = Effect.gen(function* () {
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
          prune
        ),
    });
  });
