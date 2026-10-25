import { DateTime, Effect, Layer, Option, Schema, Semaphore } from "effect";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import { batches } from "./batches.js";
import { nextSocketKey } from "./frames.js";
import { State } from "./state.js";
import { alarmPrefix, makeSchedule } from "./alarm.js";
import { keptPrefix } from "./subscriptions.js";
import { clockOwner, webhookPrefix } from "./webhooks.js";

const clockKey = `${alarmPrefix}${clockOwner}`;

const Position = Schema.Struct({ epoch: Schema.String, last: Schema.Int });

const Stored = Schema.Struct({
  at: Schema.Finite,
  key: Schema.optional(Schema.String),
  eventId: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.Finite),
  data: Schema.optional(Schema.Json),
});

const positionOf = Schema.decodeUnknownOption(Position);

const storedOf = Schema.decodeUnknownOption(Stored);

const seqWidth = 16;

type Storage = Event.LogStorage<Event.Emitted<Event.Any>>;

type Kept = Effect.Success<ReturnType<Storage["list"]>>[number][1];

/**
 * A log's storage in the object's, under `effect-actions/log/<event>/`: its position, and each
 * entry by its sequence number, its data encoded as the event's payload JSON.
 */
const storageLog = (storage: DurableObjectStorage, event: Event.Any): Storage => {
  const prefix = `effect-actions/log/${event.name}/`;
  const positionKey = `${prefix}meta`;
  const entries = `${prefix}entry/`;
  const entryKey = (seq: number) => `${entries}${String(seq).padStart(seqWidth, "0")}`;
  const seqOfKey = (key: string) => Number(key.slice(entries.length));
  const codec = Schema.toCodecJson(event.payload);
  const encode = Schema.encodeUnknownEffect(codec);
  const decode = Schema.decodeUnknownEffect(codec);

  // Why: an entry that does not decode at all, or whose data no longer decodes as the event's
  // payload, such as one an earlier deployment wrote, is listed unread, which the core sends as a
  // gap at its cursor; one with no data was logged without it, as it did not encode.
  const keptOf = (found: Option.Option<typeof Stored.Type>): Effect.Effect<Kept> =>
    Option.match(found, {
      onNone: () => Effect.succeed({ at: 0, logged: undefined }),
      onSome: (stored) =>
        Effect.map(
          stored.data === undefined
            ? Effect.succeed(Option.none())
            : Effect.option(decode(stored.data)),
          (data) => ({
            at: stored.at,
            logged: Option.match(data, {
              onNone: () => undefined,
              onSome: (value) => ({
                key: stored.key,
                value: {
                  data: value,
                  ...(stored.eventId === undefined ? {} : { eventId: stored.eventId }),
                  ...(stored.timestamp === undefined
                    ? {}
                    : { timestamp: DateTime.makeUnsafe(stored.timestamp) }),
                },
              }),
            }),
          }),
        ),
    });

  return {
    position: Effect.map(
      Effect.promise(() => storage.get<unknown>(positionKey)),
      (found) => Option.getOrUndefined(positionOf(found)),
    ),
    put: (position, entry) =>
      Effect.gen(function* () {
        if (entry === undefined) {
          return yield* Effect.promise(() => storage.put(positionKey, position));
        }

        const { at, logged } = entry.stored;

        // Why: an occurrence that does not encode is reported once, as it is appended, and kept
        // without its data, which each reader receives as a gap.
        const data = yield* encode(logged.value.data).pipe(
          Effect.map(Option.some),
          Effect.catch((error) =>
            Effect.as(
              Effect.logError(
                `An occurrence published to the log of event "${event.name}" does not encode as its payload, and is kept as a gap`,
                error,
              ),
              Option.none(),
            ),
          ),
        );

        yield* Effect.promise(() =>
          storage.put({
            [positionKey]: position,
            [entryKey(entry.seq)]: Stored.make({
              at,
              ...(logged.key === undefined ? {} : { key: logged.key }),
              ...(logged.value.eventId === undefined ? {} : { eventId: logged.value.eventId }),
              ...(logged.value.timestamp === undefined
                ? {}
                : { timestamp: DateTime.toEpochMillis(logged.value.timestamp) }),
              ...(Option.isSome(data) ? { data: data.value } : {}),
            }),
          }),
        );
      }),
    list: (from, limit) =>
      Effect.flatMap(
        Effect.promise(() =>
          storage.list<unknown>({ prefix: entries, start: entryKey(from), limit }),
        ),
        (listed) =>
          Effect.forEach(listed, ([key, value]) =>
            Effect.map(keptOf(storedOf(value)), (kept) => [seqOfKey(key), kept] as const),
          ),
      ),
    delete: (seqs) =>
      Effect.forEach(
        batches(seqs.map(entryKey)),
        (keys) => Effect.promise(() => storage.delete([...keys])),
        { discard: true },
      ),
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
const storageRevisions = (storage: DurableObjectStorage): Effect.Effect<Event.RevisionStorage> =>
  Effect.gen(function* () {
    const kept = Option.getOrUndefined(
      epochOf(yield* Effect.promise(() => storage.get<unknown>(epochKey))),
    );

    const epoch = kept ?? crypto.randomUUID();

    if (kept === undefined) yield* Effect.promise(() => storage.put(epochKey, epoch));

    const get = (name: string) =>
      Effect.map(
        Effect.promise(() => storage.get<unknown>(`${countPrefix}${name}`)),
        (found) => Option.getOrElse(countOf(found), () => 0),
      );

    // Why: a bump reads each counter, then writes it one higher; two notifies bumping at once,
    // interleaved at the read, would each write the same count, and a change would keep its
    // subscribers' revision.
    const inTurn = Semaphore.withPermit(yield* Semaphore.make(1));

    return {
      epoch,
      get,
      bump: (names) =>
        Effect.flatMap(
          Effect.forEach(names, (name) => Effect.map(get(name), (count) => [name, count] as const)),
          (counts) =>
            Effect.promise(() =>
              storage.put(
                Object.fromEntries(
                  counts.map(([name, count]) => [`${countPrefix}${name}`, count + 1]),
                ),
              ),
            ),
        ).pipe(inTurn),
    };
  });

/**
 * The object's `Event.Events`, which `handlers` and `make` provide to the services, calls and
 * routes: each log source's log kept in the object's storage, under `effect-actions/log/`, each
 * current source's revisions beside it, so a cursor outlives an eviction, and a check or current
 * source's subscribers read again when notified, not on its `nextPoll`, a timer that would keep the
 * object from hibernating.
 *
 * **Gotchas**
 *
 * - A check or current source is read when a subscriber subscribes and on each `notify`, never on its `nextPoll`: an upstream outside the object notifies it through a call, such as a method a Worker calls over its stub.
 * - A logged occurrence's data is kept as its payload's JSON: one that does not encode as it is published is logged then, and one that no longer decodes, such as after a deployment changed the payload, is reported as it is read; each is sent as a gap.
 * - Provide no other `Event.Events`, such as the core's `Event.layerMemory`, to the services or routes: it shadows this one, its logs lost at each eviction and its check sources read on a timer that keeps the object awake.
 * - A log's entries live beside the application's data: a store deleting every key deletes them too, and a subscriber resuming from one of their cursors receives a gap.
 * - A current source's revisions live beside them, under `effect-actions/revisions/`: a store deleting every key starts them again, and until the object is evicted their ids repeat ones its watches have seen, which drop them; `wipe` keeps them.
 * - Two log sources of event types sharing a name die as the second attaches, naming it: each log is kept under its event's name.
 * - A log source fed by `emit` dies as it attaches, naming `publish`: an evicted object would miss what the stream sends meanwhile, with no gap, and its open stream would keep the object awake.
 * - A subscriber's read that fails is tried again 5 seconds later, on a timer, until one succeeds: a source failing for good keeps the object awake, billed, and sends each subscriber a `Failed` each time.
 * - A poll's `subscription` hook is held until 5 minutes after its last poll, on a timer that keeps the object awake, and an eviction tears down no hook: one it ends is set up again as its subscription resumes, its teardown never run.
 */
export const layerEvents: Layer.Layer<Event.Events, never, State> = Layer.effect(Event.Events)(
  Effect.flatMap(State, ({ storage }) =>
    Effect.flatMap(storageRevisions(storage), (revisions) => {
      // Why: a log is kept under its event's name, the one identity storage keeps across
      // instances, so two event types of one name would read and append each other's entries.
      const named = new Map<string, Event.Any>();

      return Event.makeEvents({
        log: (event) => {
          const prior = named.get(event.name);

          if (prior !== undefined && prior !== event)
            throw new Error(
              `layerEvents keeps each log source's log in the object's storage by its event's name, and two event types are named "${event.name}" (give each event type a name of its own)`,
            );

          named.set(event.name, event);

          return storageLog(storage, event);
        },
        polls: false,
        emits: false,
        revisions,
      });
    }),
  ),
);

/**
 * Deletes everything the object keeps, as `storage.deleteAll()` does, its alarm included, but its
 * open sockets' event subscriptions and its webhook subscriptions, which read on from where they
 * were, a subscriber of a log source receiving a gap, the alarm time ending their waits, current
 * sources' revisions, and the id its next socket is given. Every other event of the object waits
 * until it is done.
 *
 * **Gotchas**
 *
 * - `storage.deleteAll()` alone deletes the subscriptions too: a subscriber hears nothing more once the object hibernates.
 * - A subscriber of a current source is at the revision it reached, and is sent nothing until a `notify`: notify each current source whose value the deletion changed.
 * - A subscriber of a check source reads on from its cursor in the application's emptied store, which answers it: an event id from a counter the deletion starts again repeats one the watch has seen, which it drops, so give each id something the deletion changes.
 * - The kept subscriptions keep the headers they were made with, tokens and cookies included: a deletion that must remove credentials closes those sockets too.
 * - The webhook subscriptions keep each subscriber's secret and identity: a deletion that must remove credentials deletes the keys under `effect-actions/webhooks/` too.
 * - A subscription admitted while it runs, by a call already under way, can be deleted with the rest: that watch hears nothing more once the object hibernates.
 * - A task's mark is deleted too: a task whose run failed is not run again, so run it after the deletion where its work still matters.
 */
export const wipe: Effect.Effect<void, never, State> = Effect.flatMap(State, (state) =>
  Effect.promise(() =>
    state.blockConcurrencyWhile(async () => {
      const kept = await state.storage.list<unknown>({ prefix: keptPrefix });
      const webhooks = await state.storage.list<unknown>({ prefix: webhookPrefix });
      const revisions = await state.storage.list<unknown>({ prefix: revisionPrefix });
      const next = await state.storage.get<unknown>(nextSocketKey);
      const clock = await state.storage.get<unknown>(clockKey);

      await state.storage.deleteAll();
      await state.storage.deleteAlarm();

      const entries = [
        ...kept,
        ...webhooks,
        ...revisions,
        ...(next === undefined ? [] : [[nextSocketKey, next] as const]),
        ...(clock === undefined ? [] : [[clockKey, clock] as const]),
      ];

      for (const batch of batches(entries)) await state.storage.put(Object.fromEntries(batch));

      // Why: the webhook layer's waits end at the alarm, which deleteAll cleared: set again, it
      // runs the time kept, and only the schedule's earliest is ever set.
      if (clock !== undefined) await Effect.runPromise(makeSchedule(state).rearm);
    }),
  ),
);
