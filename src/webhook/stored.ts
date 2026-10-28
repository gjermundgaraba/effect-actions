import { Duration, Effect, Option, Queue, Schema, Semaphore } from "effect";
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

const prefix = "effect-actions/webhook";

const Index = Schema.Array(Schema.String);

const flushTimeout = Duration.seconds(5);

export const makeWriteBehindStorage = (
  store: KeyValueStore.KeyValueStore
): Effect.Effect<Storage, never, Scope.Scope> =>
  Effect.gen(function* () {
    const records = KeyValueStore.toSchemaStore(
      KeyValueStore.prefix(store, `${prefix}/`),
      Stored
    );

    const index = KeyValueStore.toSchemaStore(store, Index);

    let indexed: ReadonlySet<string> = new Set(
      yield* Effect.orDie(
        Effect.map(
          index.get(prefix),
          Option.getOrElse((): readonly string[] => [])
        )
      )
    );

    const pending = new Map<string, Stored | undefined>();
    const marked = yield* Queue.sliding<undefined>(1);
    const writing = Semaphore.makeUnsafe(1);

    const listed = (next: ReadonlySet<string>) =>
      Effect.andThen(
        index.set(prefix, [...next]),
        Effect.sync(() => {
          indexed = next;
        })
      );

    const removedThenUnlisted = (id: string) =>
      Effect.andThen(
        records.remove(id),
        Effect.suspend(() =>
          indexed.has(id)
            ? listed(new Set([...indexed].filter((each) => each !== id)))
            : Effect.void
        )
      );

    const listedThenKept = (id: string, record: Stored) =>
      Effect.andThen(
        Effect.suspend(() =>
          indexed.has(id) ? Effect.void : listed(new Set([...indexed, id]))
        ),
        records.set(id, record)
      );

    const written = (id: string, record: Stored | undefined) =>
      record === undefined
        ? removedThenUnlisted(id)
        : listedThenKept(id, record);

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
      flushed.pipe(Effect.timeout(flushTimeout), Effect.ignore)
    );

    return {
      mark: (id, record) => {
        pending.set(id, record);
        Queue.offerUnsafe(marked, undefined);
      },
      ids: () => [...new Set([...indexed, ...pending.keys()])],
      get: (id) =>
        pending.has(id)
          ? Effect.succeed(Option.fromUndefinedOr(pending.get(id)))
          : records.get(id),
    };
  });
