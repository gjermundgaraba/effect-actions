import { Clock, Effect, Layer, Schema } from "effect";
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { Message, MessageNotFound, NotAuthor } from "../chat/Chat.js";
import { MessageStore } from "../chat/store.js";

const day = 24 * 60 * 60 * 1000;

const decodeRows = Schema.decodeUnknownSync(Schema.Array(Message));

const decodeRow = Schema.decodeUnknownSync(Message);

// The room's messages in the object's own SQLite database, which outlives every instance: an
// evicted instance loses its memory, never these. The Layer runs each time an instance is
// constructed, so creating the table is idempotent.
export const layerSql = Layer.effect(MessageStore)(
  Effect.gen(function* () {
    const { storage } = yield* ActionDurableObject.State;

    const query = (sql: string, ...bindings: ReadonlyArray<string | number>) =>
      decodeRows(storage.sql.exec(sql, ...bindings).toArray());

    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL)",
    );

    // The object has one alarm, set for the oldest message's expiry. It is read from the table
    // and set in one step, so posts running at once each set it for the oldest message they
    // see, and the last to set it has seen them all; reading the alarm first would let two posts
    // both see none and the later one win.
    const expireOldest = Effect.promise(async () => {
      const [oldest] = query("SELECT * FROM messages ORDER BY at LIMIT 1");

      if (oldest !== undefined) await storage.setAlarm(oldest.at + day);
    });

    return MessageStore.of({
      latest: Effect.sync(
        () => query("SELECT * FROM messages ORDER BY id DESC LIMIT 1")[0] ?? null,
      ),
      read: (after) =>
        Effect.sync(() => query("SELECT * FROM messages WHERE id > ? ORDER BY id", after)),
      post: Effect.fn("MessageStore.post")(function* (author, text) {
        const at = yield* Clock.currentTimeMillis;

        const message = decodeRow(
          storage.sql
            .exec(
              "INSERT INTO messages (author, text, at) VALUES (?, ?, ?) RETURNING *",
              author,
              text,
              at,
            )
            .one(),
        );

        yield* expireOldest;

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

        yield* expireOldest;
      }),
    });
  }),
);
