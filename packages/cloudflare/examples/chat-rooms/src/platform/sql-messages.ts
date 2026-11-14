import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { Message } from "../chat/Chat.js";
import { MessageStore } from "../chat/store.js";

const decodeMessages = Schema.decodeUnknownEffect(Schema.Array(Message));

const decodeSequence = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ seq: Schema.Int }))
);

const query = <E, R>(rows: Effect.Effect<unknown, E, R>) =>
  Effect.flatMap(rows, decodeMessages).pipe(Effect.orDie);

export const layerSqlMessages = Layer.effect(MessageStore)(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL)`;

    return MessageStore.of({
      last: sql`SELECT seq FROM sqlite_sequence WHERE name = 'messages'`.pipe(
        Effect.flatMap(decodeSequence),
        Effect.map((rows) => rows[0]?.seq ?? 0),
        Effect.orDie
      ),
      read: (after) =>
        query(sql`SELECT * FROM messages WHERE id > ${after} ORDER BY id`),
      post: (author, text, at, announce) =>
        Effect.gen(function* () {
          const [message] = yield* query(
            sql`INSERT INTO messages (author, text, at) VALUES (${author}, ${text}, ${at}) RETURNING *`
          );

          yield* announce;

          return (
            message ?? (yield* Effect.die(new Error("no message inserted")))
          );
        }).pipe(sql.withTransaction, Effect.orDie),
    });
  }).pipe(Effect.orDie)
);
