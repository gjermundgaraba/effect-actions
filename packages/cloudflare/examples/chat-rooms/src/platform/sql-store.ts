import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { Clock, DateTime, Effect, Layer, Schema } from "effect";

import { Message, MessageNotFound, NotAuthor } from "../chat/Chat.js";
import { MessageStore } from "../chat/store.js";

const day = 24 * 60 * 60 * 1000;

const decodeMessage = Schema.decodeUnknownSync(Message);

const decodeSequence = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ seq: Schema.Int }))
);

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
      "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, author TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL)"
    );

    storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS messages_by_at ON messages (at)"
    );

    const alarmForOldest = Effect.suspend(() => {
      const [oldest] = query("SELECT * FROM messages ORDER BY at LIMIT 1");

      return oldest === undefined
        ? Effect.void
        : alarm.set(DateTime.makeUnsafe(oldest.at + day));
    });

    return MessageStore.of({
      latest: Effect.sync(
        () =>
          query("SELECT * FROM messages ORDER BY id DESC LIMIT 1")[0] ?? null
      ),
      last: Effect.sync(
        () =>
          decodeSequence(
            storage.sql
              .exec("SELECT seq FROM sqlite_sequence WHERE name = 'messages'")
              .toArray()
          )[0]?.seq ?? 0
      ),
      read: (after) =>
        Effect.sync(() =>
          query("SELECT * FROM messages WHERE id > ? ORDER BY id", after)
        ),
      post: Effect.fn("MessageStore.post")(function* (author, text) {
        const at = yield* Clock.currentTimeMillis;

        const message = decodeMessage(
          storage.sql
            .exec(
              "INSERT INTO messages (author, text, at) VALUES (?, ?, ?) RETURNING *",
              author,
              text,
              at
            )
            .one()
        );

        yield* alarm.set(DateTime.makeUnsafe(message.at + day));

        return message;
      }),
      remove: Effect.fn("MessageStore.remove")(function* (author, id) {
        const [message] = query("SELECT * FROM messages WHERE id = ?", id);

        if (message === undefined) {
          return yield* new MessageNotFound({ id });
        }

        if (message.author !== author) {
          return yield* new NotAuthor({ id });
        }

        storage.sql.exec("DELETE FROM messages WHERE id = ?", id);
      }),
      expire: Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;

        storage.sql.exec("DELETE FROM messages WHERE at <= ?", now - day);

        yield* alarmForOldest;
      }),
    });
  })
);
