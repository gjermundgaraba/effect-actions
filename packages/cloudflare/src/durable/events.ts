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

export const layerEvents: Layer.Layer<Event.Events, never, State> =
  Layer.effect(Event.Events)(
    Effect.flatMap(State, ({ storage }) =>
      Effect.flatMap(storageRevisions(storage), (revisions) => {
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
