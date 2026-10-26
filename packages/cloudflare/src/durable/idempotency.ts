import { Clock, Effect, Layer, Option, Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { deleted } from "./batches.js";

/** Where the object's kept answers live, one key per action, caller's principal and idempotency key. */
const keptPrefix = "effect-actions/idempotency/";

const hour = 60 * 60 * 1000;

const keptOf = Schema.decodeUnknownOption(Action.Idempotency.Kept);

/**
 * `Action.Idempotency` over the object's storage: each answer kept 24 hours, through
 * hibernation, eviction and deployments, and deleted once its day is past as a later one is kept,
 * at most once an hour, so an object given no further key keeps its last day's answers.
 */
export const layerIdempotency = (state: DurableObjectState): Layer.Layer<Action.Idempotency> =>
  Layer.sync(Action.Idempotency)(() => {
    let prunedAt = -Infinity;

    // Why: on a write, never on the alarm, so an object nobody calls is never woken to delete
    // answers nobody reads, and an hour apart, as each prune lists every kept answer.
    const prune = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      if (now - prunedAt < hour) return;

      prunedAt = now;

      const listed = yield* Effect.promise(() => state.storage.list({ prefix: keptPrefix }));

      const expired = [...listed].flatMap(([key, value]) =>
        Option.match(keptOf(value), {
          onNone: () => [key],
          onSome: ({ at }) => (at + Action.Idempotency.keptFor <= now ? [key] : []),
        }),
      );

      yield* deleted(state.storage, expired);
    });

    return Action.Idempotency.of({
      get: (id) =>
        Effect.map(
          Effect.promise(() => state.storage.get(`${keptPrefix}${id}`)),
          (stored) => Option.getOrUndefined(keptOf(stored)),
        ),
      set: (id, kept) =>
        Effect.andThen(
          Effect.promise(() => state.storage.put(`${keptPrefix}${id}`, kept)),
          prune,
        ),
    });
  });
