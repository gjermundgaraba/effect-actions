import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";

import type * as Action from "./Action.js";
import { CallerKeyed, principalOf } from "./caller.js";
import { canonicalInput } from "./canonical.js";
import { projectedErrors } from "./declared.js";
import { sha256Hex } from "./digest.js";
import { InvalidInput } from "./errors.js";
import { answered } from "./implementation.js";
import type { ErasedValue, WrittenHandler } from "./implementation.js";
import { declaredStatus, isTransientStatus } from "./status.js";

export const Kept = Schema.Struct({
  input: Schema.String,
  outcome: Schema.String,
  at: Schema.Finite,
});

export type Kept = typeof Kept.Type;

export const keptFor = 24 * 60 * 60 * 1000;

/**
 * Where the answers of calls given an idempotency key are kept, by the action's name and a
 * SHA-256 digest in hex of the key and its caller's principal, `<action>/<digest>`, for 24 hours
 * at least: what an implementation of an action naming `idempotencyKey` requires at startup.
 * `layerIdempotency` keeps them in memory, and `Stored.layerIdempotency` in a table of the
 * `SqlClient` it is built with, such as a cluster entity's own SQLite.
 *
 * **Gotchas**
 *
 * - Provide one per server, around the surfaces: an implementation built in another layer graph keeps its own.
 * - A server waits for a repeat's first call itself, in memory: two servers sharing a store run a call each, the later answer kept.
 * - An answer is kept only after its handler returns: a crash between the handler's write and the kept answer lets a repeat run the handler again, so make the write itself idempotent where that matters, such as by a unique key on the idempotency key.
 */
export class Idempotency extends Context.Service<
  Idempotency,
  {
    /** What was kept under `id`, or `undefined`; one kept longer than 24 hours may be either. */
    readonly get: (id: string) => Effect.Effect<Kept | undefined>;
    /** Keeps `kept` under `id`, replacing what was. */
    readonly set: (id: string, kept: Kept) => Effect.Effect<void>;
  }
>()("effect-actions/Action/Idempotency") {}

/**
 * `Idempotency` in the server's memory, each answer kept 24 hours after it was kept: lost when
 * the server stops, and kept apart from every other server's.
 */
export const layerIdempotency: Layer.Layer<Idempotency> = Layer.sync(
  Idempotency
)(() => {
  const held = new Map<string, Kept>();

  return Idempotency.of({
    get: (id) => Effect.sync(() => held.get(id)),
    set: (id, kept) =>
      Effect.sync(() => {
        held.delete(id);
        held.set(id, kept);

        for (const [oldest, { at }] of held) {
          if (at > kept.at - keptFor) {
            break;
          }

          held.delete(oldest);
        }
      }),
  });
});

export const keyed = (
  action: Action.Any,
  store: Idempotency["Service"],
  handle: WrittenHandler<unknown>
): WrittenHandler<unknown> => {
  const field = action.idempotencyKey;

  if (field === undefined) {
    return handle;
  }

  const Outcome = Schema.fromJsonString(
    Schema.toCodecJson(
      Schema.Exit(
        action.success,
        Schema.Union(projectedErrors(action)),
        Schema.Never
      )
    )
  );

  const encodeOutcome = Schema.encodeUnknownEffect(Outcome);
  const decodeOutcome = Schema.decodeUnknownOption(Outcome);

  const isTransientFailure = Schema.is(
    Schema.Union(
      projectedErrors(action).filter((error) =>
        isTransientStatus(declaredStatus(error))
      )
    )
  );

  const running = new Map<string, Deferred.Deferred<undefined>>();

  const run = (
    id: string,
    key: string,
    digest: string,
    answer: Effect.Effect<ErasedValue, ErasedValue, unknown>
  ): Effect.Effect<ErasedValue, ErasedValue, unknown> =>
    Effect.gen(function* () {
      const first = running.get(id);

      if (first !== undefined) {
        yield* Deferred.await(first).pipe(
          Effect.withSpan("Idempotency.wait", {
            attributes: { "action.name": action.name },
          })
        );

        return yield* run(id, key, digest, answer);
      }

      const claim = Deferred.makeUnsafe<undefined>();

      running.set(id, claim);

      const release = Effect.andThen(
        Effect.sync(() => running.delete(id)),
        Deferred.succeed(claim, undefined)
      );

      return yield* Effect.gen(function* () {
        const kept = yield* store.get(id);

        if (kept !== undefined && kept.input !== digest) {
          return yield* new InvalidInput({
            message: `The idempotency key ${key} of ${action.name} was given with another input (send a new key for another call)`,
          });
        }

        const replayed =
          kept === undefined ? Option.none() : decodeOutcome(kept.outcome);

        if (Option.isSome(replayed)) {
          return yield* replayed.value;
        }

        const exit = yield* Effect.exit(answer);

        const keeps =
          Exit.isSuccess(exit) ||
          exit.cause.reasons.every(
            (reason) =>
              Cause.isFailReason(reason) && !isTransientFailure(reason.error)
          );

        const json = keeps
          ? yield* Effect.option(encodeOutcome(exit))
          : Option.none();

        if (Option.isSome(json)) {
          yield* store.set(id, {
            input: digest,
            outcome: json.value,
            at: yield* Clock.currentTimeMillis,
          });
        }

        return yield* exit;
      }).pipe(Effect.ensuring(release));
    });

  return (input, reporting) => {
    const key = Predicate.hasProperty(input, field) ? input[field] : undefined;

    if (!Predicate.isString(key)) {
      return handle(input, reporting);
    }

    const answer = Effect.suspend(() => answered(handle(input, reporting)));

    return Effect.flatMap(
      Effect.all([
        Effect.service(CallerKeyed).pipe(
          Effect.flatMap((named) => principalOf(action, named)),
          Effect.flatMap((principal) =>
            sha256Hex(JSON.stringify([principal ?? null, key]))
          )
        ),
        Effect.flatMap(canonicalInput(action.input, input), sha256Hex),
      ]),
      ([id, digest]) => run(`${action.name}/${id}`, key, digest, answer)
    );
  };
};
