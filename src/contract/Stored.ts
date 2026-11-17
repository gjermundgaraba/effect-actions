import { Context, Duration, Effect, Layer, Option, Schema } from "effect";
import { Persistence } from "effect/persistence";
import { SqlClient } from "effect/sql";

import {
  changeSignalQuery,
  createLogTables,
  sqlRevisions,
  sqlStorage,
} from "./event-tables.js";
import type * as Event from "./Event.js";
import { Events, makeEvents } from "./hub.js";
import { Idempotency, Kept, keptFor } from "./idempotency.js";

/**
 * What `layerEvents` calls in the fiber that made each change its change signal counts, each
 * append to a log, published or emitted, and each `notify`, once the change is written: a host
 * serving the database's events from outside `Events`, as the Cloudflare package's socket host
 * does, learns of a change as it is made, by work that outlived the call that started it too, not
 * only when a handler ends. `layerEvents` reads it as it builds; by default it does nothing, and
 * the Cloudflare package's `ActionCluster.layer` provides one to each entity's build.
 *
 * **Gotchas**
 *
 * - It is called inside the transaction that wrote the change, before that commits: a listener reading the database on the same connection sees the change uncommitted, and one a transaction rolls back has called it all the same.
 * - It runs synchronously in the writer's fiber, the write waiting on it: hand any work to another fiber, and throw nothing, as a throw is the write's defect.
 */
export const ChangeListener = Context.Reference<() => void>(
  "effect-actions/Stored/ChangeListener",
  { defaultValue: () => () => undefined }
);

/**
 * An `Events` kept in tables through the `SqlClient` it is built with, created as it builds:
 * each log source's occurrences in `effect_actions_event_log`, by event name and sequence number,
 * with its key and the occurrence as JSON, and its position in `effect_actions_event_position`;
 * each `notify` moves a counter in `effect_actions_event_revision`, the event's name counting
 * every one. For a host whose subscribers outlive it, such as a cluster entity on its own
 * SQLite: a watch resumed from a cursor after a restart on the same database receives every
 * occurrence past it within the log's bounds, `maxAge` (10 minutes by default) and `maxEvents`.
 * Its change signal, which `changeSignal` reads, moves at each `notify` and each append to a
 * log, published or emitted, and at no read or restart: a host reads it to learn whether a poll
 * could answer anything new, and `ChangeListener`, read as it builds, is called at each move.
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

      const counted = yield* sqlRevisions(sql);
      const changed = yield* ChangeListener;
      const named = new Map<string, Event.Any>();

      const revisions = {
        ...counted,
        bump: (names: readonly string[]) =>
          Effect.tap(counted.bump(names), () => Effect.sync(changed)),
      };

      return yield* makeEvents({
        log: (event) => {
          const prior = named.get(event.name);

          if (prior !== undefined && prior !== event) {
            throw new Error(
              `Stored.layerEvents keeps each log source's log by its event's name, and two event types are named "${event.name}" (give each event type a name of its own)`
            );
          }

          named.set(event.name, event);

          const storage = sqlStorage(
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

          return {
            ...storage,
            put: (position, entry) =>
              Effect.tap(storage.put(position, entry), () =>
                entry === undefined ? Effect.void : Effect.sync(changed)
              ),
          };
        },
        revisions,
      });
    }).pipe(Effect.orDie)
  );

/**
 * The SQL query reading `layerEvents`' change signal from its database, one row whose `signal`
 * column is the sum of `effect_actions_event_revision`'s counts and of
 * `effect_actions_event_position`'s `last` sequence numbers: it moves at each `notify` and each
 * append to a log, and at no read or restart, so a host that runs it as `ChangeListener` is
 * called and after each handler, as the Cloudflare package's socket host does, learns whether a
 * parked poll could answer anything new.
 *
 * **Gotchas**
 *
 * - Before `layerEvents` first builds on the database its tables are missing, and the query fails with SQLite's `no such table`: the Cloudflare package's socket host reads that as no signal, answering polls at once as for an entity whose events are kept elsewhere, and fails a poll with a defect on any other failure, as on tables of another shape.
 */
export const changeSignal: string = changeSignalQuery;

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
