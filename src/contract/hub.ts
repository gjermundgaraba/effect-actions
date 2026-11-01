import { Context, Effect, Layer, Queue, Stream } from "effect";
import type { Scope } from "effect";

import type * as Event from "./Event.js";
import { makeLog, makeLogStore, memoryStorage } from "./log.js";
import type { Bounds, Log, LogStorage } from "./log.js";

/** What `notify` and `publish` take: the key whose subscribers they reach. */
export interface KeyOptions {
  /**
   * Reach only the subscribers whose source's `key` answers this, such as one room's; without
   * it, every subscriber of the event. A subscriber of a source without `key` is reached either way.
   */
  readonly key?: string | undefined;
}

type ErasedEmitted = Event.Emitted<Event.Any>;

type TakeWake = Effect.Effect<void>;

export type Wakes = (
  key: string | undefined
) => Effect.Effect<TakeWake, never, Scope.Scope>;

export interface Checking {
  readonly wakes: Wakes;
  readonly polls: boolean;
  readonly revision: (key: string | undefined) => Effect.Effect<string>;
}

/**
 * Where an `Events` keeps its current sources' revisions: counters by name, which only count up,
 * in an `epoch` telling them from counters that started again.
 */
export interface RevisionStorage {
  /**
   * The epoch the counters count in, run before each revision is built from it: one value until
   * the counters start again, so a cursor from before is behind every revision, kept by the time
   * it succeeds.
   */
  readonly epoch: Effect.Effect<string>;
  readonly get: (name: string) => Effect.Effect<number>;
  /** Adds one to each counter `names` names. */
  readonly bump: (names: readonly string[]) => Effect.Effect<void>;
}

const memoryRevisions = (): RevisionStorage => {
  const counts = new Map<string, number>();

  return {
    epoch: Effect.succeed(globalThis.crypto.randomUUID()),
    get: (name) => Effect.sync(() => counts.get(name) ?? 0),
    bump: (names) =>
      Effect.sync(() => {
        for (const name of names) {
          counts.set(name, (counts.get(name) ?? 0) + 1);
        }
      }),
  };
};

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
    readonly notify: (
      event: Event.Any,
      options?: KeyOptions
    ) => Effect.Effect<void>;
    /** Appends `emitted` to `event`'s log, delivering it to the log source's subscribers now. */
    readonly publish: <E extends Event.Any>(
      event: E,
      emitted: Event.Emitted<E>,
      options?: KeyOptions
    ) => Effect.Effect<void>;
  }
>()("effect-actions/Event/Events") {}

interface Attachments {
  readonly check: (
    event: Event.Any,
    current: boolean
  ) => Effect.Effect<Checking, never, Scope.Scope>;
  readonly log: (
    event: Event.Any,
    bounds: Bounds | undefined,
    emit: Emitting | undefined
  ) => Effect.Effect<Log<ErasedEmitted>, never, Scope.Scope>;
}

const attached = new WeakMap<Events["Service"], Attachments>();

export const attachmentsOf = (
  events: Events["Service"]
): Effect.Effect<Attachments> =>
  Effect.suspend(() => {
    const attachments = attached.get(events);

    return attachments === undefined
      ? Effect.die(
          new Error(
            "This Event.Events serves no event implementation: provide Event.layerMemory, or one Event.makeEvents builds"
          )
        )
      : Effect.succeed(attachments);
  });

interface Waiter {
  readonly key: string | undefined;
  readonly woken: Queue.Queue<undefined>;
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

export const reaches = (target: string | undefined, key: string | undefined) =>
  target === undefined || key === undefined || target === key;

const holding = <A>(
  set: Set<A>,
  value: A
): Effect.Effect<A, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      set.add(value);

      return value;
    }),
    () => Effect.sync(() => set.delete(value))
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
  options: MakeEventsOptions
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

    const isCheck = (event: Event.Any) =>
      (checks.get(event)?.attached.size ?? 0) > 0;

    const feed = (kept: Kept): Effect.Effect<void> =>
      Effect.suspend(() => {
        const [next] = kept.feeding ? [] : kept.waiting;

        if (next === undefined) {
          return Effect.void;
        }

        kept.waiting.delete(next);
        kept.feeding = true;

        const fed = Effect.andThen(
          kept.log.feed(
            Stream.map(next.emit, ({ key, ...value }) => ({ value, key }))
          ),
          Effect.suspend(() => {
            kept.feeding = false;

            return feed(kept);
          })
        );

        return Effect.asVoid(Effect.forkIn(fed, scope));
      });

    const fedBy = (kept: Kept, emit: Emitting) =>
      Effect.tap(holding(kept.waiting, { emit }), () => feed(kept));

    const events = Events.of({
      notify: (event, notifyOptions) =>
        Effect.suspend(() => {
          if (!isCheck(event) && logs.has(event)) {
            return Effect.die(
              new Error(
                `Event "${event.name}" has a log source, which keeps what is published: give each occurrence to publish (Event.Events.publish(event, { data }))`
              )
            );
          }

          const key = notifyOptions?.key;

          return Effect.andThen(
            checks.get(event)?.current === false
              ? Effect.void
              : revisions.bump([
                  everyKey(event),
                  key === undefined ? noKey(event) : ofKey(event, key),
                ]),
            Effect.sync(() => {
              for (const waiter of checkOf(event).waiters) {
                if (reaches(key, waiter.key)) {
                  Queue.offerUnsafe(waiter.woken, undefined);
                }
              }
            })
          );
        }),
      publish: (event, emitted, publishOptions) =>
        Effect.suspend(() => {
          const kept = logs.get(event);

          if (kept !== undefined) {
            return kept.log.append(emitted, publishOptions?.key);
          }

          return isCheck(event)
            ? Effect.die(
                new Error(
                  `Event "${event.name}" has a check source, which reads your store: write the occurrence there, then wake its subscribers (Event.Events.notify(event))`
                )
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
              Effect.flatMap(Queue.sliding<undefined>(1), (woken) =>
                Effect.as(
                  holding(checkOf(event).waiters, { key, woken }),
                  Queue.take(woken)
                )
              ),
            revision: (key) =>
              key === undefined
                ? Effect.map(
                    Effect.all([
                      revisions.epoch,
                      revisions.get(everyKey(event)),
                    ]),
                    ([epoch, count]) => `${epoch}:${count}`
                  )
                : Effect.map(
                    Effect.all([
                      revisions.epoch,
                      revisions.get(noKey(event)),
                      revisions.get(ofKey(event, key)),
                    ]),
                    ([epoch, unkeyed, keyed]) =>
                      `${epoch}:${unkeyed + keyed}:${key}`
                  ),
          })
        ),
      log: (event, bounds, emit) =>
        Effect.suspend(() => {
          if (emit !== undefined && !emits) {
            return Effect.die(
              new Error(
                `Event "${event.name}" has a log source fed by emit, which this Event.Events does not consume, as its host does not last between requests (publish each occurrence with Event.Events.publish as the host receives it, such as in a call or a route)`
              )
            );
          }

          const kept = logs.get(event) ?? {
            log: makeLog(makeLogStore(options.log(event), bounds)),
            waiting: new Set(),
            feeding: false,
          };

          logs.set(event, kept);

          return Effect.as(
            emit === undefined ? Effect.void : fedBy(kept, emit),
            kept.log
          );
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
  makeEvents({ log: () => memoryStorage() })
);
