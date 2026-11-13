import { Duration, Effect, Layer, Option, Schema } from "effect";
import { Persistence } from "effect/persistence";
import { SqlClient } from "effect/sql";

import { createLogTables, sqlRevisions, sqlStorage } from "./event-tables.js";
import type * as Event from "./Event.js";
import { Events, makeEvents } from "./hub.js";
import { Idempotency, Kept, keptFor } from "./idempotency.js";

/**
 * An `Events` kept in tables through the `SqlClient` it is built with, created as it builds:
 * each log source's occurrences in `effect_actions_event_log`, by event name and sequence number,
 * with its key and the occurrence as JSON, and its position in `effect_actions_event_position`;
 * each `notify` moves a counter in `effect_actions_event_revision`, the event's name counting
 * every one. For a host whose subscribers outlive it, such as a cluster entity on its own
 * SQLite: a watch resumed from a cursor after a restart on the same database receives every
 * occurrence past it within the log's bounds, `maxAge` (10 minutes by default) and `maxEvents`.
 * Its change signal is `(SELECT total(count) FROM effect_actions_event_revision) + (SELECT
 * total(last) FROM effect_actions_event_position)`, which each `notify` and each append to a
 * log, published or emitted, moves, and no read or restart does: a host reads it to learn
 * whether a poll could answer anything new.
 *
 * **Gotchas**
 *
 * - Written for SQLite, such as a cluster entity's own on a Durable Object, `CloudflareCluster.DurableObjectSqlClient`, and tested on `@effect/sql-sqlite-node`'s and on workerd: another dialect is unsupported.
 * - Build it once per database, as `Event.layerMemory` is built once per process: two builds over one database each wake only their own subscribers, and their appends to one log collide, dying on the table's key.
 * - Logs are kept by their event's name: two event types of one name attached to one build die, naming it.
 * - A `key` holding a lone surrogate, not well-formed UTF-16, is kept with U+FFFD in its place: its occurrences no longer reach that key's subscribers.
 * - A query that fails dies: the database is the host's own, and nothing else can answer for it.
 * - Each append and read of a log is a transaction, joining the caller's: on a Durable Object, `CloudflareCluster.DurableObjectSqlClient` is `@effect/sql-sqlite-do`'s `SqliteClient` built with `storage`, and one built with `db` alone fails every one, which dies; an occurrence published in a transaction that rolls back is not kept, though its subscribers are woken to read nothing.
 */
export const layerEvents: Layer.Layer<Events, never, SqlClient.SqlClient> =
  Layer.effect(Events)(
    Effect.gen(function* () {
      const sql = (yield* SqlClient.SqlClient).withoutTransforms();

      yield* createLogTables(sql);

      const revisions = yield* sqlRevisions(sql);
      const named = new Map<string, Event.Any>();

      return yield* makeEvents({
        log: (event) => {
          const prior = named.get(event.name);

          if (prior !== undefined && prior !== event) {
            throw new Error(
              `Stored.layerEvents keeps each log source's log by its event's name, and two event types are named "${event.name}" (give each event type a name of its own)`
            );
          }

          named.set(event.name, event);

          return sqlStorage(
            sql,
            event.name,
            Schema.fromJsonString(
              Schema.toCodecJson(
                Schema.Struct({
                  data: event.payload,
                  eventId: Schema.optional(Schema.String),
                  timestamp: Schema.optional(Schema.DateTimeUtcFromMillis),
                })
              )
            )
          );
        },
        revisions,
      });
    }).pipe(Effect.orDie)
  );

const decodeKept = Schema.decodeUnknownOption(Kept);

/**
 * `Idempotency` in a table of the `SqlClient` it is built with, created as it builds,
 * `effect_persistence_effect_actions_idempotency`, each answer kept 24 hours: in a database that
 * outlives the server, such as a cluster entity's own SQLite.
 *
 * **Gotchas**
 *
 * - An expired answer is never read back, and is deleted as the layer builds: a long-running server keeps the rows of expired answers until it builds again, as a cluster entity does each time it activates.
 * - A database failing to read or keep an answer dies: the call fails, its answer not kept.
 */
export const layerIdempotency: Layer.Layer<
  Idempotency,
  never,
  SqlClient.SqlClient
> = Layer.effect(Idempotency)(
  Effect.gen(function* () {
    const store = yield* (yield* Persistence.BackingPersistence).make(
      "effect_actions_idempotency"
    );

    return Idempotency.of({
      get: (id) =>
        store.get(id).pipe(
          Effect.orDie,
          Effect.map((value) => Option.getOrUndefined(decodeKept(value)))
        ),
      set: (id, kept) =>
        Effect.orDie(store.set(id, kept, Duration.millis(keptFor))),
    });
  })
).pipe(Layer.provide(Persistence.layerBackingSqlMultiTable));
