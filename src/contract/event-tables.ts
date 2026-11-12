import { Array as Arr, Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";

import type { RevisionStorage } from "./hub.js";
import type { LogStorage, Position } from "./log.js";

const entryTable = "effect_actions_event_log";

const positionTable = "effect_actions_event_position";

export const createLogTables = (sql: SqlClient.SqlClient) =>
  Effect.andThen(
    sql`CREATE TABLE IF NOT EXISTS ${sql(positionTable)} (
      event TEXT PRIMARY KEY,
      epoch TEXT NOT NULL,
      last BIGINT NOT NULL
    )`,
    sql`CREATE TABLE IF NOT EXISTS ${sql(entryTable)} (
      event TEXT NOT NULL,
      seq BIGINT NOT NULL,
      at BIGINT NOT NULL,
      key TEXT,
      value TEXT,
      PRIMARY KEY (event, seq)
    )`
  );

const PositionRows = Schema.Array(
  Schema.Struct({ epoch: Schema.String, last: Schema.Int })
);

const EntryRows = Schema.Array(
  Schema.Struct({
    seq: Schema.Int,
    at: Schema.Finite,
    key: Schema.NullOr(Schema.String),
    value: Schema.NullOr(Schema.String),
  })
);

const decodePositions = Schema.decodeUnknownEffect(PositionRows);

const decodeEntries = Schema.decodeUnknownEffect(EntryRows);

const seqsPerDelete = 90;

export const sqlStorage = <A>(
  sql: SqlClient.SqlClient,
  name: string,
  codec: Schema.Codec<A, string>
): LogStorage<A> => {
  const encode = Schema.encodeEffect(codec);
  const decode = Schema.decodeEffect(codec);
  const positions = sql(positionTable);
  const entries = sql(entryTable);

  const upsertPosition = ({ epoch, last }: Position) =>
    sql`INSERT INTO ${positions} (event, epoch, last) VALUES (${name}, ${epoch}, ${last})
      ON CONFLICT (event) DO UPDATE SET epoch = excluded.epoch, last = excluded.last`;

  return {
    position:
      sql`SELECT epoch, last FROM ${positions} WHERE event = ${name}`.pipe(
        Effect.flatMap(decodePositions),
        Effect.map((rows) => rows[0]),
        Effect.orDie
      ),
    put: (position, entry) =>
      Effect.gen(function* () {
        if (entry === undefined) {
          yield* upsertPosition(position);

          return;
        }

        const { at, logged } = entry.stored;

        const value = yield* encode(logged.value).pipe(
          Effect.catch((error) =>
            Effect.as(
              Effect.logError(
                `An occurrence published to the log of event "${name}" does not encode as its payload, and is kept as a gap`,
                error
              ),
              null
            )
          )
        );

        yield* upsertPosition(position);
        yield* sql`INSERT INTO ${entries} (event, seq, at, key, value)
          VALUES (${name}, ${entry.seq}, ${at}, ${logged.key ?? null}, ${value})`;
      }).pipe(Effect.orDie),
    list: (from, limit) =>
      sql`SELECT seq, at, key, value FROM ${entries}
        WHERE event = ${name} AND seq >= ${from} ORDER BY seq LIMIT ${limit}`.pipe(
        Effect.flatMap(decodeEntries),
        Effect.flatMap((rows) =>
          Effect.forEach(rows, ({ seq, at, key, value }) =>
            Effect.map(
              value === null
                ? Effect.succeedNone
                : Effect.option(decode(value)),
              (decoded) =>
                [
                  seq,
                  {
                    at,
                    logged: Option.getOrUndefined(
                      Option.map(decoded, (kept) => ({
                        value: kept,
                        key: key ?? undefined,
                      }))
                    ),
                  },
                ] as const
            )
          )
        ),
        Effect.orDie
      ),
    delete: (seqs) =>
      Effect.forEach(
        Arr.chunksOf(seqs, seqsPerDelete),
        (chunk) =>
          sql`DELETE FROM ${entries} WHERE event = ${name} AND ${sql.in("seq", chunk)}`,
        { discard: true }
      ).pipe(Effect.orDie),
    transaction: (operation) => Effect.orDie(sql.withTransaction(operation)),
  };
};

const revisionTable = "effect_actions_event_revision";

const revisionEpochTable = "effect_actions_event_revision_epoch";

const Counts = Schema.Array(Schema.Struct({ count: Schema.Int }));

const Epochs = Schema.NonEmptyArray(Schema.Struct({ epoch: Schema.String }));

export const sqlRevisions = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const counts = sql(revisionTable);
    const epochs = sql(revisionEpochTable);

    yield* sql`CREATE TABLE IF NOT EXISTS ${counts} (
      name TEXT PRIMARY KEY,
      count BIGINT NOT NULL
    )`;

    yield* sql`CREATE TABLE IF NOT EXISTS ${epochs} (
      id INTEGER PRIMARY KEY CHECK (id = 0),
      epoch TEXT NOT NULL
    )`;

    yield* sql`INSERT INTO ${epochs} (id, epoch) VALUES (0, ${globalThis.crypto.randomUUID()})
      ON CONFLICT (id) DO NOTHING`;

    const [{ epoch }] = yield* sql`SELECT epoch FROM ${epochs}`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Epochs))
    );

    return {
      epoch: Effect.succeed(epoch),
      get: (name) =>
        sql`SELECT count FROM ${counts} WHERE name = ${name}`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Counts)),
          Effect.map((rows) => rows[0]?.count ?? 0),
          Effect.orDie
        ),
      bump: (names) =>
        Arr.isReadonlyArrayNonEmpty(names)
          ? sql`INSERT INTO ${counts} ${sql.insert(Arr.map(names, (name) => ({ name, count: 1 })))}
              ON CONFLICT (name) DO UPDATE SET count = ${counts}.count + 1`.pipe(
              Effect.asVoid,
              Effect.orDie
            )
          : Effect.void,
    } satisfies RevisionStorage;
  });
