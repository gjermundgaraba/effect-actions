import { Context, Effect, Layer, Queue, type Scope, Stream } from "effect";
import type * as Event from "./Event.js";
import {
  type Bounds,
  type Log,
  type LogStorage,
  makeLog,
  makeLogStore,
  memoryStorage,
} from "./log.js";

/** What `notify` and `publish` take: the key whose subscribers they reach. */
export interface KeyOptions {
  /**
   * Reach only the subscribers whose source's `key` answers this, such as one room's; without
   * it, every subscriber of the event. A subscriber of a source without `key` is reached either way.
   */
  readonly key?: string | undefined;
}

type ErasedEmitted = Event.Emitted<Event.Any>;

/**
 * How a subscriber of a check source is woken: a waiter for `key`'s wakes, held in the scope,
 * each take completing once it was woken since the last.
 */
export type Wakes = (
  key: string | undefined,
) => Effect.Effect<Effect.Effect<void>, never, Scope.Scope>;

/**
 * How a check source's subscribers learn to read again: `wakes`, and a timer where `polls`; and
 * a current source's revision for a key, which each `notify` reaching that key moves.
 */
export interface Checking {
  readonly wakes: Wakes;
  /** Whether a subscriber also reads again after each page's `nextPoll`. */
  readonly polls: boolean;
  /**
   * The revision a subscriber of `key` is at, as a cursor: `<epoch>:<count>`, then `:<key>` for a
   * key, so a cursor kept for another key is behind every revision of this one.
   */
  readonly revision: (key: string | undefined) => Effect.Effect<string>;
}

/**
 * Where an `Events` keeps its current sources' revisions: counters by name, which only count up,
 * in an `epoch` telling them from counters that started again.
 */
export interface RevisionStorage {
  /** Changes whenever the counters start again, so a cursor from before is behind every revision. */
  readonly epoch: string;
  readonly get: (name: string) => Effect.Effect<number>;
  /** Adds one to each counter `names` names. */
  readonly bump: (names: ReadonlyArray<string>) => Effect.Effect<void>;
}

/** Revisions kept in memory, starting again, in a new epoch, with each call. */
const memoryRevisions = (): RevisionStorage => {
  const counts = new Map<string, number>();

  return {
    epoch: globalThis.crypto.randomUUID(),
    get: (name) => Effect.sync(() => counts.get(name) ?? 0),
    bump: (names) =>
      Effect.sync(() => {
        for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
      }),
  };
};

// Why: A subscriber of a key is at its key's count plus every notify without a key, and one
// following every key at the count of every notify: each count moves exactly when a notify reaches
// that subscriber, never for another key's, so a current source answers no unchanged value. A key
// is written after a mark no unkeyed name ends with, so the empty key is a key like any other.
const everyKey = (event: Event.Any) => event.name;

const noKey = (event: Event.Any) => `${event.name}\u0000`;

const ofKey = (event: Event.Any, key: string) => `${event.name}\u0000=${key}`;

/**
 * Where an event's occurrences are announced as they happen: `notify` wakes the subscribers of a
 * check source to read now, and `publish` appends an occurrence to a log source, both reaching
 * the subscribers of one `key` or every one. Domain code yields it as it yields a store, and an
 * entrypoint provides one implementation: `Event.layerMemory`, kept in a process's memory.
 * Every surface serving events and `Action.client` watching them need it.
 *
 * **Gotchas**
 *
 * - The handlers announcing and the surfaces serving must share one, as they share a store: built separately, as a test building its handlers under a `provide` of their own does, each has its own, and an announcement reaches no subscriber of the other.
 * - An event no implementation attached here has no subscribers here: `publish` does nothing for it, and `notify` only moves its revision, so a current source attached later answers the change.
 * - `notify` of a log source and `publish` to a check source die naming the other: a check source reads your store, so write there and notify; a log source keeps what you publish.
 * - Implementations attach only to one `layerMemory` or `makeEvents` made: built over another, such as `Events.of` in a test, they die, naming both.
 */
export class Events extends Context.Service<
  Events,
  {
    /** Wakes the subscribers of `event`'s check source to read it now, rather than at their next poll. */
    readonly notify: (event: Event.Any, options?: KeyOptions) => Effect.Effect<void>;
    /** Appends `emitted` to `event`'s log, delivering it to the log source's subscribers now. */
    readonly publish: <E extends Event.Any>(
      event: E,
      emitted: Event.Emitted<E>,
      options?: KeyOptions,
    ) => Effect.Effect<void>;
  }
>()("effect-actions/Event/Events") {}

/** How an implementation's sources attach to an `Events` as it builds. */
interface Attachments {
  /** How a check or current source's subscribers are woken, for as long as the scope lasts. */
  readonly check: (
    event: Event.Any,
    current: boolean,
  ) => Effect.Effect<Checking, never, Scope.Scope>;
  /**
   * `event`'s one log, kept as long as the `Events` is, made with `bounds` at the first
   * attachment, and fed by `emit` where given, unless the scope ends before its turn.
   */
  readonly log: (
    event: Event.Any,
    bounds: Bounds | undefined,
    emit: Emitting | undefined,
  ) => Effect.Effect<Log<ErasedEmitted>, never, Scope.Scope>;
}

// Why: Attaching a source is the surfaces' business, never domain code's, so it is kept by the
// service it belongs to rather than on the service domain code yields.
const attached = new WeakMap<Events["Service"], Attachments>();

/** How sources attach to `events`, the `Events` `makeEvents` made; one made otherwise dies. */
export const attachmentsOf = (events: Events["Service"]): Effect.Effect<Attachments> =>
  Effect.suspend(() => {
    const attachments = attached.get(events);

    return attachments === undefined
      ? Effect.die(
          new Error(
            "This Event.Events serves no event implementation: provide Event.layerMemory, or one Event.makeEvents builds",
          ),
        )
      : Effect.succeed(attachments);
  });

interface Waiter {
  readonly key: string | undefined;
  readonly woken: Queue.Queue<void>;
}

type Emitting = Stream.Stream<ErasedEmitted & KeyOptions>;

interface Held {
  readonly emit: Emitting;
}

interface Kept {
  readonly log: Log<ErasedEmitted>;
  readonly waiting: Set<Held>;
  feeding: boolean;
}

/** Whether an announcement to `target` reaches a subscriber of `key`: either absent means every one. */
export const reaches = (target: string | undefined, key: string | undefined) =>
  target === undefined || key === undefined || target === key;

const holding = <A>(set: Set<A>, value: A): Effect.Effect<A, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      set.add(value);

      return value;
    }),
    () => Effect.sync(() => set.delete(value)),
  );

/** `makeEvents`' options: where it keeps logs, and whether check sources are read on a timer. */
export interface MakeEventsOptions {
  /**
   * The storage of `event`'s log, made at its first attachment: the core keeps the log's cursors,
   * bounds and expiry over it.
   */
  readonly log: (event: Event.Any) => LogStorage<ErasedEmitted>;
  /**
   * Whether a check source's subscribers also read it again on a timer, each page's `nextPoll`,
   * besides when notified; defaults to `true`. `false` where a pending timer would keep the host
   * awake, as it keeps a Durable Object from hibernating: its sources are read when notified, and
   * 5 seconds after a read that fails.
   */
  readonly polls?: boolean | undefined;
  /**
   * Whether a log source's `emit` is consumed; defaults to `true`. `false` where the host does not
   * last, as a Durable Object is evicted while idle and misses what a stream sends meanwhile: a
   * log source fed by `emit` dies as it attaches, naming `publish`.
   */
  readonly emits?: boolean | undefined;
  /**
   * Where current sources' revisions are kept; defaults to memory, a new epoch with each
   * `makeEvents`. A host keeping its logs in storage keeps them there too, so a subscriber's
   * cursor outlives the host.
   */
  readonly revisions?: RevisionStorage | undefined;
}

/**
 * An `Events` for as long as the scope lasts, over the log storage `log` makes: what a host keeping
 * logs elsewhere, such as a Durable Object's storage, provides as `Events`, its subscribers' wakes
 * in memory and its logs where `log` keeps them.
 *
 * **Gotchas**
 *
 * - Make it once per host, around the handlers that announce and the surfaces that serve, as `layerMemory` is built.
 * - A log's storage is made once per event for the life of the scope, its position read on every append and read: a storage emptied behind its back, as `storage.deleteAll` empties one, starts a new epoch, and a cursor from before reads a gap.
 */
export const makeEvents = (
  options: MakeEventsOptions,
): Effect.Effect<Events["Service"], never, Scope.Scope> =>
  Effect.gen(function* () {
    const polls = options.polls ?? true;
    const emits = options.emits ?? true;
    const revisions = options.revisions ?? memoryRevisions();
    const scope = yield* Effect.scope;

    const checks = new Map<
      Event.Any,
      { attached: Set<object>; waiters: Set<Waiter>; current?: boolean }
    >();

    const logs = new Map<Event.Any, Kept>();

    const checkOf = (event: Event.Any) => {
      const found = checks.get(event) ?? {
        attached: new Set<object>(),
        waiters: new Set<Waiter>(),
      };

      checks.set(event, found);

      return found;
    };

    const isCheck = (event: Event.Any) => (checks.get(event)?.attached.size ?? 0) > 0;

    // Why: one emit stream feeds a log at a time, so two builds of one source never append each
    // occurrence twice, until it ends or fails, its build released or not: interrupting it as its
    // build is released would lose what a shared upstream sends before the next one subscribes.
    // The next held one then takes over; one whose build is released before its turn never feeds.
    const feed = (kept: Kept): Effect.Effect<void> =>
      Effect.suspend(() => {
        const [next] = kept.feeding ? [] : kept.waiting;

        if (next === undefined) return Effect.void;

        kept.waiting.delete(next);
        kept.feeding = true;

        const fed = Effect.andThen(
          kept.log.feed(Stream.map(next.emit, ({ key, ...value }) => ({ value, key }))),
          Effect.suspend(() => {
            kept.feeding = false;

            return feed(kept);
          }),
        );

        return Effect.asVoid(Effect.forkIn(fed, scope));
      });

    const fedBy = (kept: Kept, emit: Emitting) =>
      Effect.tap(holding(kept.waiting, { emit }), () => feed(kept));

    const events = Events.of({
      notify: (event, options) =>
        Effect.suspend(() => {
          if (!isCheck(event) && logs.has(event)) {
            return Effect.die(
              new Error(
                `Event "${event.name}" has a log source, which keeps what is published: give each occurrence to publish (Event.Events.publish(event, { data }))`,
              ),
            );
          }

          const key = options?.key;

          // Why: The revision moves at every notify of an event not attached as a check source,
          // whose subscribers never read it: a request-scoped server attaches a current source
          // only while it serves a request, so a change announced between requests is read at
          // the next. It moves before a subscriber wakes, so the read it wakes to answers the
          // value written before this notify.
          return Effect.andThen(
            checks.get(event)?.current === false
              ? Effect.void
              : revisions.bump([
                  everyKey(event),
                  key === undefined ? noKey(event) : ofKey(event, key),
                ]),
            Effect.sync(() => {
              for (const waiter of checkOf(event).waiters) {
                if (reaches(key, waiter.key)) Queue.offerUnsafe(waiter.woken, undefined);
              }
            }),
          );
        }),
      publish: (event, emitted, options) =>
        Effect.suspend(() => {
          const kept = logs.get(event);

          if (kept !== undefined) return kept.log.append(emitted, options?.key);

          return isCheck(event)
            ? Effect.die(
                new Error(
                  `Event "${event.name}" has a check source, which reads your store: write the occurrence there, then wake its subscribers (Event.Events.notify(event))`,
                ),
              )
            : Effect.void;
        }),
    });

    attached.set(events, {
      check: (event, current) =>
        Effect.map(
          holding(Object.assign(checkOf(event), { current }).attached, {}),
          (): Checking => ({
            polls,
            wakes: (key) =>
              Effect.flatMap(Queue.sliding<void>(1), (woken) =>
                Effect.as(holding(checkOf(event).waiters, { key, woken }), Queue.take(woken)),
              ),
            revision: (key) =>
              key === undefined
                ? Effect.map(
                    revisions.get(everyKey(event)),
                    (count) => `${revisions.epoch}:${count}`,
                  )
                : Effect.map(
                    Effect.all([revisions.get(noKey(event)), revisions.get(ofKey(event, key))]),
                    ([unkeyed, keyed]) => `${revisions.epoch}:${unkeyed + keyed}:${key}`,
                  ),
          }),
        ),
      log: (event, bounds, emit) =>
        Effect.suspend(() => {
          if (emit !== undefined && !emits)
            return Effect.die(
              new Error(
                `Event "${event.name}" has a log source fed by emit, which this Event.Events does not consume, as its host does not last between requests (publish each occurrence with Event.Events.publish as the host receives it, such as in a call or a route)`,
              ),
            );

          const kept = logs.get(event) ?? {
            log: makeLog(makeLogStore(options.log(event), bounds)),
            waiting: new Set(),
            feeding: false,
          };

          logs.set(event, kept);

          return Effect.as(emit === undefined ? Effect.void : fedBy(kept, emit), kept.log);
        }),
    });

    return events;
  });

/**
 * An `Events` kept in the memory of the process that builds it: for a server holding its
 * subscribers' connections itself, such as Node's, and for tests.
 *
 * **Gotchas**
 *
 * - Build it once, around the handlers that announce and the surfaces that serve, as a store is: each build is its own.
 * - A log lives as long as this build, through rebuilds of the implementations attached to it: a restart forgets it, and a subscriber resuming from one of its cursors receives a gap.
 * - Several builds of one log source share its log, and its `emit` feeds it from one build at a time, so nothing is appended twice.
 */
export const layerMemory: Layer.Layer<Events> = Layer.effect(Events)(
  makeEvents({ log: () => memoryStorage() }),
);
