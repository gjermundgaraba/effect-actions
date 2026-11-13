import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { DemoRoomName } from "../chat/Chat.js";
import type { RoomPreview } from "../lobby/Lobby.js";
import { PreviewStore } from "../lobby/store.js";

const decodePreviews = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      room: DemoRoomName,
      latest_at: Schema.NullOr(Schema.Int),
      version: Schema.Int,
    })
  )
);

export const layerSqlPreviews = Layer.effect(PreviewStore)(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`CREATE TABLE IF NOT EXISTS previews (room TEXT PRIMARY KEY, latest_at INTEGER, version INTEGER NOT NULL)`;

    const kept = Effect.map(
      Effect.flatMap(
        sql`SELECT room, latest_at, version FROM previews`,
        decodePreviews
      ),
      (rows) => new Map(rows.map((row) => [row.room, row]))
    );

    return PreviewStore.of({
      read: Effect.map(kept, (rows) =>
        DemoRoomName.literals.map((room): RoomPreview => ({
          room,
          latestAt: rows.get(room)?.latest_at ?? null,
        }))
      ).pipe(Effect.orDie),
      record: ({ preview: { room, latestAt }, version }, announce) =>
        Effect.gen(function* () {
          const before = (yield* kept).get(room);

          if (before !== undefined && before.version >= version) {
            return;
          }

          yield* sql`INSERT INTO previews (room, latest_at, version) VALUES (${room}, ${latestAt}, ${version}) ON CONFLICT (room) DO UPDATE SET latest_at = excluded.latest_at, version = excluded.version`;

          if ((before?.latest_at ?? null) !== latestAt) {
            yield* announce;
          }
        }).pipe(sql.withTransaction, Effect.orDie),
    });
  }).pipe(Effect.orDie)
);
