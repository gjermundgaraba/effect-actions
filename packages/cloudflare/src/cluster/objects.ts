import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster";
import { Effect, Option, Predicate } from "effect";
import type { SqlClient } from "effect/sql";

/** What `ActionCluster.ObjectState` holds, whose JSDoc says what each field is. */
export interface Recorded extends Pick<
  DurableObjectState,
  "id" | "storage" | "waitUntil" | "abort"
> {
  readonly database: {
    readonly sql: SqlStorage;
    readonly transaction: <A>(closure: () => Promise<A>) => Promise<A>;
  };
}

interface Held {
  readonly state: DurableObjectState;
  changed: () => void;
  recorded?: { readonly sql: SqlClient.SqlClient; readonly state: Recorded };
}

const held = new WeakMap<DurableObjectStorage, Held>();

const isStorage = (value: unknown): value is DurableObjectStorage =>
  Predicate.hasProperty(value, "sql") &&
  Predicate.hasProperty(value, "transaction");

export const hold = (state: DurableObjectState): void => {
  held.set(state.storage, { state, changed: () => undefined });
};

export const listen = (state: DurableObjectState, listener: () => void) => {
  const found = held.get(state.storage);

  if (found !== undefined) {
    found.changed = listener;
  }
};

/**
 * The SQL client and storage of the entity object whose build, call or forked work runs this:
 * the runtime's `DurableObjectSqlClient` is `@effect/sql-sqlite-do`'s client built over the
 * storage, which it keeps as its `config.storage`; `undefined` outside an entity object.
 */
export const objectHere: Effect.Effect<
  | {
      readonly sql: SqlClient.SqlClient;
      readonly storage: DurableObjectStorage;
    }
  | undefined
> = Effect.map(
  Effect.serviceOption(CloudflareCluster.DurableObjectSqlClient),
  (found) => {
    const sql = Option.getOrUndefined(found);

    const config = Predicate.hasProperty(sql, "config")
      ? sql.config
      : undefined;

    const storage = Predicate.hasProperty(config, "storage")
      ? config.storage
      : undefined;

    return sql !== undefined && isStorage(storage)
      ? { sql, storage }
      : undefined;
  }
);

export const stateHere = (
  sql: SqlClient.SqlClient,
  storage: DurableObjectStorage
): Recorded | undefined => {
  const found = held.get(storage);

  if (found === undefined) {
    return undefined;
  }

  if (found.recorded?.sql !== sql) {
    const { state } = found;

    found.recorded = {
      sql,
      state: {
        id: state.id,
        storage,
        waitUntil: (promise) => {
          state.waitUntil(promise);
        },
        abort: (reason) => {
          state.abort(reason);
        },
        database: {
          sql: storage.sql,
          transaction: async (closure) =>
            await Effect.runPromise(
              sql.withTransaction(Effect.promise(closure))
            ),
        },
      },
    };
  }

  return found.recorded.state;
};

export const changedIn = (storage: DurableObjectStorage): void => {
  held.get(storage)?.changed();
};
