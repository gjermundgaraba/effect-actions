import {
  Cause,
  Duration,
  Effect,
  Option,
  Queue,
  Schema,
  Semaphore,
} from "effect";
import type { Scope } from "effect";
import { KeyValueStore } from "effect/persistence";

import { CallbackUrl, WebhookSecret } from "../contract/callback.js";
import { reported } from "../contract/reported.js";
import { DeliveryStatus } from "../contract/subscribe.js";

export const Stored = Schema.Struct({
  url: CallbackUrl,
  event: Schema.String,
  input: Schema.Json,
  identity: Schema.Json,
  secret: WebhookSecret,
  expiresAt: Schema.Finite,
  watermark: Schema.NullOr(Schema.String),
  status: DeliveryStatus,
});

export type Stored = typeof Stored.Type;

export interface Storage {
  readonly mark: (id: string, record: Stored | undefined) => void;
  readonly ids: () => readonly string[];
  readonly get: (
    id: string
  ) => Effect.Effect<
    Option.Option<Stored>,
    KeyValueStore.KeyValueStoreError | Schema.SchemaError
  >;
}

const prefix = "effect-actions/webhook/";

const flushTimeout = Duration.seconds(5);

class UnfinishedWrites extends Schema.TaggedError<
  UnfinishedWrites,
  { readonly brand: unique symbol }
>()("UnfinishedWrites", {
  ids: Schema.Array(Schema.String),
  message: Schema.String,
}) {
  static of(ids: readonly string[]): UnfinishedWrites {
    return new UnfinishedWrites({
      ids,
      message: `Webhook.layer closed with subscriptions ${ids.join(", ")} unwritten after ${Duration.format(flushTimeout)}: the store keeps each one's last write`,
    });
  }
}

export const makeWriteBehindStorage = (
  store: KeyValueStore.KeyValueStore
): Effect.Effect<Storage, never, Scope.Scope> =>
  Effect.gen(function* () {
    const records = KeyValueStore.toSchemaStore(
      KeyValueStore.prefix(store, prefix),
      Stored
    );

    const kept = new Set(yield* Effect.orDie(records.keys));
    const pending = new Map<string, Stored | undefined>();
    const marked = yield* Queue.sliding<undefined>(1);
    const writing = Semaphore.makeUnsafe(1);

    const written = (id: string, record: Stored | undefined) =>
      Effect.andThen(
        record === undefined ? records.remove(id) : records.set(id, record),
        Effect.sync(() => {
          if (record === undefined) {
            kept.delete(id);
          } else {
            kept.add(id);
          }
        })
      );

    const clearedUnlessRemarked = (id: string, record: Stored | undefined) =>
      Effect.sync(() => {
        if (pending.get(id) === record) {
          pending.delete(id);
        }
      });

    const flushed = writing.withPermits(1)(
      Effect.suspend(() =>
        Effect.forEach(
          [...pending],
          ([id, record]) =>
            written(id, record).pipe(
              Effect.andThen(clearedUnlessRemarked(id, record)),
              Effect.catchCause(reported)
            ),
          { discard: true }
        )
      )
    );

    yield* Effect.forkScoped(
      Effect.forever(Effect.andThen(Queue.take(marked), flushed))
    );
    yield* Effect.addFinalizer(() =>
      Effect.timeoutOrElse(flushed, {
        duration: flushTimeout,
        orElse: () =>
          reported(Cause.fail(UnfinishedWrites.of([...pending.keys()]))),
      })
    );

    return {
      mark: (id, record) => {
        pending.set(id, record);
        Queue.offerUnsafe(marked, undefined);
      },
      ids: () => [...new Set([...kept, ...pending.keys()])],
      get: (id) =>
        pending.has(id)
          ? Effect.succeed(Option.fromUndefinedOr(pending.get(id)))
          : records.get(id),
    };
  });
