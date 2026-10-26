import { Duration, Effect, Option, Queue, Schema, type Scope, Semaphore } from "effect";
import { KeyValueStore } from "effect/persistence";
import { reported } from "../contract/reported.js";
import { CallbackUrl, WebhookSecret } from "../contract/callback.js";
import { DeliveryStatus } from "../contract/subscribe.js";

/**
 * A webhook subscription as `persist` keeps it, enough to start delivering again after a
 * restart: its callback, event, encoded input and identity, secret, expiry, watermark and
 * status. Its callback and secret are decoded again as it is read, as a request's are.
 */
export const Stored = Schema.Struct({
  url: CallbackUrl,
  event: Schema.String,
  input: Schema.Json,
  principal: Schema.String,
  identity: Schema.Json,
  secret: WebhookSecret,
  expiresAt: Schema.Finite,
  watermark: Schema.NullOr(Schema.String),
  status: DeliveryStatus,
});

export type Stored = typeof Stored.Type;

/**
 * Where a layer's subscriptions are kept: `mark` asks for one to be written, or removed where its
 * record is `undefined`, the latest mark of an id winning; `ids` and `get` read what is kept, the
 * marks not yet written included.
 */
export interface Storage {
  readonly mark: (id: string, record: Stored | undefined) => void;
  readonly ids: () => ReadonlyArray<string>;
  readonly get: (id: string) => Effect.Effect<Option.Option<Stored>, unknown>;
}

const prefix = "effect-actions/webhook";

// Why: A store has no listing, so an index of the ids lives beside the records; the layer is
// its one writer, so it reads the index once and keeps it in memory.
const Index = Schema.Array(Schema.String);

// Why: What is marked as the layer closes is written then, for at most this long, so a store
// that does not answer cannot hold up the shutdown.
const flushTimeout = Duration.seconds(5);

/**
 * A storage over `store`. Its writes run on a fiber of their own, never in the request or the
 * delivery that marked them, so a slow or failing store holds up neither: a failure is reported,
 * and written again with the next mark or as the layer closes.
 * A store whose index cannot be read fails the layer as it builds.
 */
export const makeStorage = (
  store: KeyValueStore.KeyValueStore,
): Effect.Effect<Storage, never, Scope.Scope> =>
  Effect.gen(function* () {
    const records = KeyValueStore.toSchemaStore(KeyValueStore.prefix(store, `${prefix}/`), Stored);
    const index = KeyValueStore.toSchemaStore(store, Index);

    let indexed: ReadonlySet<string> = new Set(
      yield* Effect.orDie(
        Effect.map(
          index.get(prefix),
          Option.getOrElse((): ReadonlyArray<string> => []),
        ),
      ),
    );

    const pending = new Map<string, Stored | undefined>();
    // Why: One wake stands for every mark since the last write, which writes what each left.
    const marked = yield* Queue.sliding<void>(1);
    const writing = Semaphore.makeUnsafe(1);

    // Why: What the index lists changes once it is written, so a mark after a failed write
    // writes it again.
    const listed = (next: ReadonlySet<string>) =>
      Effect.andThen(
        index.set(prefix, [...next]),
        Effect.sync(() => {
          indexed = next;
        }),
      );

    // Why: The index is written before a record it lists and after one it no longer lists, so an
    // interrupted write leaves at most an id with no record, which a restore removes.
    const written = (id: string, record: Stored | undefined) =>
      record === undefined
        ? Effect.andThen(
            records.remove(id),
            Effect.suspend(() =>
              indexed.has(id)
                ? listed(new Set([...indexed].filter((each) => each !== id)))
                : Effect.void,
            ),
          )
        : Effect.andThen(
            Effect.suspend(() =>
              indexed.has(id) ? Effect.void : listed(new Set([...indexed, id])),
            ),
            records.set(id, record),
          );

    // Why: A pass writes what was marked as it began, each mark leaving `pending` once written
    // unless a later one replaced it, so a write that fails stays to be written by the next pass,
    // which the next mark or the layer's closing runs, rather than again at once, for good.
    const flushed = writing.withPermits(1)(
      Effect.suspend(() =>
        Effect.forEach(
          [...pending],
          ([id, record]) =>
            written(id, record).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  if (pending.get(id) === record) pending.delete(id);
                }),
              ),
              Effect.catchCause(reported),
            ),
          { discard: true },
        ),
      ),
    );

    yield* Effect.forkScoped(Effect.forever(Effect.andThen(Queue.take(marked), flushed)));
    yield* Effect.addFinalizer(() => flushed.pipe(Effect.timeout(flushTimeout), Effect.ignore));

    return {
      mark: (id, record) => {
        pending.set(id, record);
        Queue.offerUnsafe(marked, undefined);
      },
      ids: () => [...new Set([...indexed, ...pending.keys()])],
      get: (id) =>
        pending.has(id) ? Effect.succeed(Option.fromUndefinedOr(pending.get(id))) : records.get(id),
    };
  });
