import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { Message, MessageNotFound, NotAuthor } from "../chat/Chat.js";
import { MessageStore } from "../chat/store.js";

const decodeMessages = Schema.decodeUnknownEffect(Schema.Array(Message));

const decodeSequence = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ seq: Schema.Int }))
);

const decodeLatest = Schema.decodeUnknownEffect(
  Schema.Tuple([
    Schema.Struct({ at: Schema.NullOr(Schema.Int), version: Schema.Int }),
  ])
);

const query = <E, R>(rows: Effect.Effect<unknown, E, R>) =>
  Effect.flatMap(rows, decodeMessages).pipe(Effect.orDie);

const first = <E, R>(rows: Effect.Effect<unknown, E, R>) =>
  Effect.map(query(rows), (messages) => messages[0] ?? null);

export const layerSqlMessages = Layer.effect(MessageStore)(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL)`;
    yield* sql`CREATE INDEX IF NOT EXISTS messages_by_at ON messages (at)`;
    yield* sql`CREATE TABLE IF NOT EXISTS room_version (version INTEGER NOT NULL)`;
    yield* sql`INSERT INTO room_version (version) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM room_version)`;

    const changed = sql`UPDATE room_version SET version = version + 1`;

    return MessageStore.of({
      latest:
        sql`SELECT (SELECT at FROM messages ORDER BY id DESC LIMIT 1) AS at, version FROM room_version`.pipe(
          Effect.flatMap(decodeLatest),
          Effect.map(([latest]) => latest),
          Effect.orDie
        ),
      oldest: first(sql`SELECT * FROM messages ORDER BY at LIMIT 1`),
      last: sql`SELECT seq FROM sqlite_sequence WHERE name = 'messages'`.pipe(
        Effect.flatMap(decodeSequence),
        Effect.map((rows) => rows[0]?.seq ?? 0),
        Effect.orDie
      ),
      read: (after) =>
        query(sql`SELECT * FROM messages WHERE id > ${after} ORDER BY id`),
      post: (author, text, at) =>
        Effect.gen(function* () {
          const [message] = yield* query(
            sql`INSERT INTO messages (author, text, at) VALUES (${author}, ${text}, ${at}) RETURNING *`
          );

          yield* changed;

          return (
            message ?? (yield* Effect.die(new Error("no message inserted")))
          );
        }).pipe(sql.withTransaction, Effect.orDie),
      remove: Effect.fn("MessageStore.remove")(function* (author, id) {
        const message = yield* first(
          sql`SELECT * FROM messages WHERE id = ${id}`
        );

        if (message === null) {
          return yield* new MessageNotFound({ id });
        }

        if (message.author !== author) {
          return yield* new NotAuthor({ id });
        }

        yield* Effect.orDie(
          sql`DELETE FROM messages WHERE id = ${id}`.pipe(
            Effect.andThen(changed),
            sql.withTransaction
          )
        );
      }),
      expire: (before) =>
        sql`DELETE FROM messages WHERE at <= ${before}`.pipe(
          Effect.andThen(changed),
          sql.withTransaction,
          Effect.orDie
        ),
    });
  }).pipe(Effect.orDie)
);
