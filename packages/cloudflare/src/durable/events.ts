import * as Event from "@gjermundgaraba/effect-actions/Event";
import { Effect, Function, Layer, Option, Schema, Semaphore } from "effect";

import { deleted } from "./batches.js";
import { State } from "./state.js";

const Position = Schema.Struct({ epoch: Schema.String, last: Schema.Int });

const Stored = Schema.Struct({
  at: Schema.Finite,
  key: Schema.optional(Schema.String),
  eventId: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.DateTimeUtcFromMillis),
  data: Schema.optional(Schema.Json),
});

const positionOf = Schema.decodeUnknownOption(Position);

const storedOf = Schema.decodeUnknownOption(Stored);

const encodeStored = Schema.encodeSync(Stored);

const seqWidth = 16;

type Emitted = Event.Emitted<Event.Any>;

/**
 * A log's storage in the object's, under `effect-actions/log/<event>/`: its position, and each
 * entry by its sequence number, its data encoded as the event's payload JSON.
 */
const storageLog = (
  storage: DurableObjectStorage,
  event: Event.Any
): Event.LogStorage<Emitted> => {
  const prefix = `effect-actions/log/${event.name}/`;
  const positionKey = `${prefix}meta`;
  const entries = `${prefix}entry/`;

  const entryKey = (seq: number) =>
    `${entries}${String(seq).padStart(seqWidth, "0")}`;

  const seqOfKey = (key: string) => Number(key.slice(entries.length));
  const codec = Schema.toCodecJson(event.payload);
  const encode = Schema.encodeUnknownEffect(codec);
  const decode = Schema.decodeUnknownEffect(codec);

  // Why: an entry that does not decode at all, or whose data no longer decodes as the event's
  // payload, such as one an earlier deployment wrote, is listed unread, which the core sends as a
  // gap at its cursor; one with no data was logged without it, as it did not encode.
  const listedOf = (
    found: Option.Option<typeof Stored.Type>
  ): Effect.Effect<Event.Listed<Emitted>> =>
    Option.match(found, {
      onNone: () => Effect.succeed({ at: 0, logged: undefined }),
      onSome: ({ at, key, eventId, timestamp, data }) =>
        Effect.map(
          data === undefined ? Effect.succeedNone : Effect.option(decode(data)),
          (decoded) => ({
            at,
            logged: Option.match(decoded, {
              onNone: Function.constUndefined,
              onSome: (payload) => ({
                key,
                value: { data: payload, eventId, timestamp },
              }),
            }),
          })
        ),
    });

  return {
    position: Effect.map(
      Effect.promise(async () => await storage.get(positionKey)),
      (found) => Option.getOrUndefined(positionOf(found))
    ),
    put: (position, entry) =>
      Effect.gen(function* () {
        if (entry === undefined) {
          return yield* Effect.promise(async () => {
            await storage.put(positionKey, position);
          });
        }

        const { at, logged } = entry.stored;

        // Why: an occurrence that does not encode is reported once, as it is appended, and kept
        // without its data, which each reader receives as a gap.
        const data = yield* encode(logged.value.data).pipe(
          Effect.catch((error) =>
            Effect.as(
              Effect.logError(
                `An occurrence published to the log of event "${event.name}" does not encode as its payload, and is kept as a gap`,
                error
              ),
              undefined
            )
          )
        );

        yield* Effect.promise(async () => {
          await storage.put({
            [positionKey]: position,
            [entryKey(entry.seq)]: encodeStored({
              at,
              key: logged.key,
              eventId: logged.value.eventId,
              timestamp: logged.value.timestamp,
              data,
            }),
          });
        });
      }),
    list: (from, limit) =>
      Effect.flatMap(
        Effect.promise(
          async () =>
            await storage.list({
              prefix: entries,
              start: entryKey(from),
              limit,
            })
        ),
        (listed) =>
          Effect.forEach(listed, ([key, value]) =>
            Effect.map(
              listedOf(storedOf(value)),
              (kept) => [seqOfKey(key), kept] as const
            )
          )
      ),
    delete: (seqs) => deleted(storage, seqs.map(entryKey)),
  };
};

const revisionPrefix = "effect-actions/revisions/";

const epochKey = `${revisionPrefix}epoch`;

const countPrefix = `${revisionPrefix}count/`;

const epochOf = Schema.decodeUnknownOption(Schema.String);

const countOf = Schema.decodeUnknownOption(Schema.Int);

/**
 * Current sources' revisions in the object's storage, under `effect-actions/revisions/`: an
 * epoch made as the object first builds, and a counter by name.
 */
const storageRevisions = (
  storage: DurableObjectStorage
): Effect.Effect<Event.RevisionStorage> => {
  const get = (name: string) =>
    Effect.map(
      Effect.promise(async () => await storage.get(`${countPrefix}${name}`)),
      (found) => Option.getOrElse(countOf(found), () => 0)
    );

  return Effect.gen(function* () {
    const kept = Option.getOrUndefined(
      epochOf(yield* Effect.promise(async () => await storage.get(epochKey)))
    );

    const epoch = kept ?? crypto.randomUUID();

    if (kept === undefined) {
      yield* Effect.promise(async () => {
        await storage.put(epochKey, epoch);
      });
    }

    // Why: a bump reads each counter, then writes it one higher; two notifies bumping at once,
    // interleaved at the read, would each write the same count, and a change would keep its
    // subscribers' revision.
    const inTurn = Semaphore.withPermit(yield* Semaphore.make(1));

    return {
      epoch,
      get,
      bump: (names) =>
        Effect.flatMap(
          Effect.forEach(names, (name) =>
            Effect.map(get(name), (count) => [name, count] as const)
          ),
          (counts) =>
            Effect.promise(async () => {
              await storage.put(
                Object.fromEntries(
                  counts.map(([name, count]) => [
                    `${countPrefix}${name}`,
                    count + 1,
                  ])
                )
              );
            })
        ).pipe(inTurn),
    };
  });
};

/**
 * The object's `Event.Events`, which `handlers` and `make` provide to the services, calls and
 * routes: each log source's log kept in the object's storage, under `effect-actions/log/`, each
 * current source's revisions beside it, so a cursor outlives an eviction, and a check or current
 * source's subscribers read again when notified, not on its `nextPoll`, a timer that would keep the
 * object from hibernating. Its rules are on `handlers`.
 */
export const layerEvents: Layer.Layer<Event.Events, never, State> =
  Layer.effect(Event.Events)(
    Effect.flatMap(State, ({ storage }) =>
      Effect.flatMap(storageRevisions(storage), (revisions) => {
        // Why: a log is kept under its event's name, the one identity storage keeps across
        // instances, so two event types of one name would read and append each other's entries.
        const named = new Map<string, Event.Any>();

        return Event.makeEvents({
          log: (event) => {
            const prior = named.get(event.name);

            if (prior !== undefined && prior !== event) {
              throw new Error(
                `An object's Event.Events keeps each log source's log in the object's storage by its event's name, and two event types are named "${event.name}" (give each event type a name of its own)`
              );
            }

            named.set(event.name, event);

            return storageLog(storage, event);
          },
          polls: false,
          emits: false,
          revisions,
        });
      })
    )
  );
