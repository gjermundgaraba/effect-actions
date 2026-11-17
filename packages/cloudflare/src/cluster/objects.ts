import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster";
import { Effect, Option, Predicate } from "effect";

interface Held {
  readonly state: DurableObjectState;
  changed: () => void;
}

const held = new WeakMap<DurableObjectStorage, Held>();

const isStorage = (value: unknown): value is DurableObjectStorage =>
  Predicate.hasProperty(value, "sql") &&
  Predicate.hasProperty(value, "transaction");

/**
 * Records an entity object's state by its storage, from its class's constructor, for
 * `ActionCluster.ObjectState` and for the listener `listen` sets.
 */
export const hold = (state: DurableObjectState): void => {
  held.set(state.storage, { state, changed: () => undefined });
};

/** Calls `listener` at each change `Stored.layerEvents` makes in the object of `state`, which `hold` recorded. */
export const listen = (state: DurableObjectState, listener: () => void) => {
  const found = held.get(state.storage);

  if (found !== undefined) {
    found.changed = listener;
  }
};

/**
 * The storage of the entity object whose build, call or forked work runs this: the runtime's
 * `DurableObjectSqlClient` is `@effect/sql-sqlite-do`'s client built over it, which keeps it as
 * its `config.storage`; `undefined` outside an entity object.
 */
export const storageHere: Effect.Effect<DurableObjectStorage | undefined> =
  Effect.map(
    Effect.serviceOption(CloudflareCluster.DurableObjectSqlClient),
    (found) => {
      const sql = Option.getOrUndefined(found);

      const config = Predicate.hasProperty(sql, "config")
        ? sql.config
        : undefined;

      const storage = Predicate.hasProperty(config, "storage")
        ? config.storage
        : undefined;

      return isStorage(storage) ? storage : undefined;
    }
  );

/** The state `hold` recorded for `storage`, if its object's class recorded one. */
export const stateOf = (
  storage: DurableObjectStorage
): DurableObjectState | undefined => held.get(storage)?.state;

/** Tells the listener of the object of `storage`, if it has one, that its events changed. */
export const changedIn = (storage: DurableObjectStorage): void => {
  held.get(storage)?.changed();
};
