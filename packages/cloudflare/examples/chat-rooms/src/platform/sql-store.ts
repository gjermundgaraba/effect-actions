import { Clock, DateTime, Effect, Layer, Schema } from "effect";
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { Message, MessageNotFound, NotAuthor } from "../chat/Chat.js";
import { MessageStore } from "../chat/store.js";

const day = 24 * 60 * 60 * 1000;

const decodeMessage = Schema.decodeUnknownSync(Message);

const decodeSequence = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ seq: Schema.Int })));

// The room's messages in the object's own SQLite database, which outlives every instance: an
// evicted instance loses its memory, never these. The Layer runs each time an instance is
// constructed, so creating the table is idempotent.
export const layerSql = Layer.effect(MessageStore)(
  Effect.gen(function* () {
    const { storage } = yield* ActionDurableObject.State;
    const alarm = yield* ActionDurableObject.Alarm;

    const query = (sql: string, ...bindings: ReadonlyArray<string | number>) =>
      storage.sql
        .exec(sql, ...bindings)
        .toArray()
        .map((row) => decodeMessage(row));

    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL)",
    );

    // Every post looks up the oldest message: indexed, it reads one row, where a scan would read
    // the whole table, and SQLite storage is billed by rows read.
    storage.sql.exec("CREATE INDEX IF NOT EXISTS messages_by_at ON messages (at)");

    // The room's alarm is due no later than the oldest message's expiry: `post` and `expire` set
    // it for the oldest message, read from the table and set in one step, so posts running at
    // once each set it for the oldest they see, and the last to set it has seen them all; reading
    // the alarm first would let two posts both see none and the later one win. Removing the
    // oldest message leaves its alarm, which then finds nothing due and moves on.
    const alarmForOldest = Effect.suspend(() => {
      const [oldest] = query("SELECT * FROM messages ORDER BY at LIMIT 1");

      return oldest === undefined ? Effect.void : alarm.set(DateTime.makeUnsafe(oldest.at + day));
    });

    return MessageStore.of({
      latest: Effect.sync(
        () => query("SELECT * FROM messages ORDER BY id DESC LIMIT 1")[0] ?? null,
      ),
      // AUTOINCREMENT keeps the highest id it ever gave in `sqlite_sequence`, so the last id
      // outlives the message: one that expired or was deleted still counts.
      last: Effect.sync(
        () =>
          decodeSequence(
            storage.sql.exec("SELECT seq FROM sqlite_sequence WHERE name = 'messages'").toArray(),
          )[0]?.seq ?? 0,
      ),
      read: (after) =>
        Effect.sync(() => query("SELECT * FROM messages WHERE id > ? ORDER BY id", after)),
      post: Effect.fn("MessageStore.post")(function* (author, text) {
        const at = yield* Clock.currentTimeMillis;

        const message = decodeMessage(
          storage.sql
            .exec(
              "INSERT INTO messages (author, text, at) VALUES (?, ?, ?) RETURNING *",
              author,
              text,
              at,
            )
            .one(),
        );

        yield* alarmForOldest;

        return message;
      }),
      remove: Effect.fn("MessageStore.remove")(function* (author, id) {
        const [message] = query("SELECT * FROM messages WHERE id = ?", id);

        if (message === undefined) return yield* new MessageNotFound({ id });

        if (message.author !== author) return yield* new NotAuthor({ id });

        storage.sql.exec("DELETE FROM messages WHERE id = ?", id);
      }),
      expire: Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;

        storage.sql.exec("DELETE FROM messages WHERE at <= ?", now - day);

        yield* alarmForOldest;
      }),
    });
  }),
);
