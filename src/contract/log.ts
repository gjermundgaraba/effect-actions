import { Cause, Clock, Duration, Effect, Option, Queue, Semaphore, Stream } from "effect";
import { reported } from "./reported.js";
import { uniqueKey } from "./implementation.js";

/** What a log holds: each entry with its sequence number, its cursor and when it arrived. */
export interface Entry<A> {
  readonly seq: number;
  /** The position after this entry, which a subscriber resumes from. */
  readonly cursor: string;
  readonly at: number;
  readonly value: A;
}

/** What a log answers for a cursor: the entries after it, at most `limit`. */
export interface Read<A> {
  readonly entries: ReadonlyArray<Entry<A>>;
  /** The position reading resumed from, before these entries. */
  readonly after: string;
  /** The position after these entries, or where reading resumed when there are none. */
  readonly cursor: string;
  readonly truncated: boolean;
  readonly hasMore: boolean;
}

/** How much a log keeps: entries of at most `maxAge`, at most `maxEvents` of them. */
export interface Bounds {
  readonly maxAge?: Duration.Input | undefined;
  readonly maxEvents?: number | undefined;
}

const defaultBounds = { maxAge: Duration.minutes(10), maxEvents: 10_000 } as const;

/** One entry of a log: what was published, and the key it was published to, if any. */
export interface Logged<A> {
  readonly value: A;
  readonly key: string | undefined;
}

/** Where a log stands: the epoch its cursors name, and the last sequence number it gave. */
export interface Position {
  readonly epoch: string;
  readonly last: number;
}

/** One entry as a log's storage keeps it: when it was appended, and what was published. */
export interface Stored<A> {
  readonly at: number;
  readonly logged: Logged<A>;
}

/**
 * One entry as a log's storage lists it: as it was kept, or with `logged` `undefined` where the
 * storage could not read it back, such as data an earlier deployment wrote in another shape,
 * which a subscriber receives as a gap at its cursor.
 */
export interface Listed<A> {
  readonly at: number;
  readonly logged: Logged<A> | undefined;
}

/**
 * Where a log keeps its position and its entries, by sequence number, as `Event.makeEvents` is
 * given it: storage alone, the log's cursors, bounds, truncation and expiry being the core's.
 */
export interface LogStorage<A> {
  /** The position `put` last kept, or `undefined` for a storage never written or emptied. */
  readonly position: Effect.Effect<Position | undefined>;
  /** Keeps `position`, and `entry` with it where given, at once. */
  readonly put: (
    position: Position,
    entry?: { readonly seq: number; readonly stored: Stored<A> },
  ) => Effect.Effect<void>;
  /** The entries kept from sequence number `from` on, at most `limit`, in order. */
  readonly list: (
    from: number,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<readonly [seq: number, listed: Listed<A>]>>;
  readonly delete: (seqs: ReadonlyArray<number>) => Effect.Effect<void>;
}

/** A log storage in memory, for the process that makes it. */
export const memoryStorage = <A>(): LogStorage<A> => {
  let position: Position | undefined;
  let newest = 0;
  const entries = new Map<number, Stored<A>>();

  return {
    position: Effect.sync(() => position),
    put: (next, entry) =>
      Effect.sync(() => {
        position = next;

        if (entry === undefined) return;

        entries.set(entry.seq, entry.stored);
        newest = Math.max(newest, entry.seq);
      }),
    // Why: a follower reads at the tip, so its read looks up the entries from its position
    // rather than walking every kept entry before it, up to `maxEvents` of them, on each publish.
    list: (from, limit) =>
      Effect.sync(() => {
        const listed: Array<readonly [number, Stored<A>]> = [];
        const oldest = entries.keys().next().value;

        if (oldest === undefined) return listed;

        for (let seq = Math.max(from, oldest); seq <= newest && listed.length < limit; seq++) {
          const stored = entries.get(seq);

          if (stored !== undefined) listed.push([seq, stored]);
        }

        return listed;
      }),
    delete: (seqs) =>
      Effect.sync(() => {
        for (const seq of seqs) entries.delete(seq);
      }),
  };
};

/** What a log keeps of its entries: appending stamps one, and reading answers by cursor. */
export interface LogStore<A> {
  /** Keeps `logged` as the next entry. */
  readonly append: (logged: Logged<A>) => Effect.Effect<void>;
  /**
   * The entries after `cursor`, at most `limit`, or after the last one for `null`: a cursor
   * naming no position kept, such as another epoch's, reads from the oldest kept, `truncated`.
   */
  readonly read: (
    cursor: string | null,
    limit: number,
  ) => Effect.Effect<Read<Logged<A> | undefined>>;
}

const separator = ":";

/**
 * A log's entries over `storage`, read by cursor: a cursor is the storage's epoch and the
 * sequence number of the last entry it has seen, so one minted by another epoch, such as a
 * memory log's before a restart or a storage's before it was emptied, reads as truncated, as
 * does one whose next entries were dropped. An epoch is minted where the storage holds none.
 */
export const makeLogStore = <A>(
  storage: LogStorage<A>,
  { maxAge = defaultBounds.maxAge, maxEvents = defaultBounds.maxEvents }: Bounds = {},
  mintEpoch: () => string = uniqueKey,
): LogStore<A> => {
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) {
    throw new Error(`Invalid log maxEvents: ${maxEvents} (give a positive integer)`);
  }

  const age = Duration.toMillis(Duration.fromInputUnsafe(maxAge));

  // Why: appends and reads take turns, so two appends never take one sequence number.
  const turn = Semaphore.makeUnsafe(1);

  const positioned = Effect.flatMap(storage.position, (found) => {
    if (found !== undefined) return Effect.succeed(found);

    const minted = { epoch: mintEpoch(), last: 0 };

    return Effect.as(storage.put(minted), minted);
  });

  const cursorAt = (epoch: string, seq: number) => `${epoch}${separator}${seq}`;

  const seqIn = (epoch: string, cursor: string): number | undefined => {
    const [named, seq, ...rest] = cursor.split(separator);
    const parsed = Number(seq);

    return named === epoch && rest.length === 0 && Number.isSafeInteger(parsed) && parsed >= 0
      ? parsed
      : undefined;
  };

  // Why: entries past their age are deleted as a read meets them, oldest first, so the oldest
  // entry kept is the first listed: a read where none expired lists one entry.
  const oldestKept = (last: number, now: number) =>
    Effect.gen(function* () {
      for (let batch = 1; ; batch = 64) {
        const listed = yield* storage.list(0, batch);
        const young = listed.findIndex(([, { at }]) => at >= now - age);
        const dropped = young === -1 ? listed : listed.slice(0, young);

        if (dropped.length > 0) yield* storage.delete(dropped.map(([seq]) => seq));

        const first = listed[dropped.length];

        if (first !== undefined) return Math.max(first[0], last - maxEvents + 1);

        if (listed.length < batch) return last + 1;
      }
    });

  return {
    append: (logged) =>
      turn.withPermit(
        Effect.gen(function* () {
          const { epoch, last } = yield* positioned;
          const seq = last + 1;
          const at = yield* Clock.currentTimeMillis;

          yield* storage.put({ epoch, last: seq }, { seq, stored: { at, logged } });

          if (seq > maxEvents) yield* storage.delete([seq - maxEvents]);
        }),
      ),
    read: (cursor, limit) =>
      turn.withPermit(
        Effect.gen(function* () {
          const { epoch, last } = yield* positioned;
          const oldest = yield* oldestKept(last, yield* Clock.currentTimeMillis);
          const seq = cursor === null ? last : seqIn(epoch, cursor);

          const { after, truncated } =
            seq === undefined || seq > last || seq + 1 < oldest
              ? { after: oldest - 1, truncated: true }
              : { after: seq, truncated: false };

          const pending = yield* storage.list(after + 1, limit + 1);
          const page = pending.slice(0, limit);

          return {
            entries: page.map(([at, stored]) => ({
              seq: at,
              cursor: cursorAt(epoch, at),
              at: stored.at,
              value: stored.logged,
            })),
            after: cursorAt(epoch, after),
            cursor: cursorAt(epoch, page.at(-1)?.[0] ?? after),
            truncated,
            hasMore: pending.length > limit,
          };
        }),
      ),
  };
};

/** What a log source keeps, appended to by `publish` and its `emit` stream. */
export interface Log<A> {
  readonly append: (value: A, key: string | undefined) => Effect.Effect<void>;
  /** Appends each value of `emit`, unkeyed, until it ends or is interrupted. */
  readonly feed: (emit: Stream.Stream<A>) => Effect.Effect<void>;
  readonly read: (
    cursor: string | null,
    limit: number,
  ) => Effect.Effect<Read<Logged<A> | undefined>>;
  /**
   * Every read after `cursor`, then one each time entries arrive: the first from where `cursor`
   * resumes, entries or not, and each truncated where the follower fell behind what is kept.
   */
  readonly follow: (
    cursor: string | null,
    limit: number,
  ) => Stream.Stream<Read<Logged<A> | undefined>>;
}

/** A log over `store`, waking its followers as each entry is appended. */
export const makeLog = <A>(store: LogStore<A>): Log<A> => {
  // Why: The store is the only keeper of entries, so a follower that falls behind reads a gap and
  // holds nothing; each follower's queue only wakes it, keeping one pending wake.
  const followers = new Set<Queue.Queue<void>>();

  const append = (value: A, key: string | undefined) =>
    Effect.andThen(
      store.append({ value, key }),
      Effect.sync(() => {
        for (const woken of followers) Queue.offerUnsafe(woken, undefined);
      }),
    );

  const following = Effect.acquireRelease(
    Effect.tap(Queue.sliding<void>(1), (woken) => Effect.sync(() => followers.add(woken))),
    (woken) => Effect.sync(() => followers.delete(woken)),
  );

  return {
    append,
    feed: (emit) =>
      emit.pipe(
        Stream.runForEach((value) => append(value, undefined)),
        Effect.matchCauseEffect({
          onFailure: (cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : reported(cause)),
          onSuccess: () =>
            Effect.logWarning("A log source's emit stream ended: it appends nothing more"),
        }),
      ),
    read: store.read,
    follow: (cursor, limit) =>
      Stream.unwrap(
        Effect.map(following, (woken) =>
          Stream.paginate({ cursor, wait: false }, (state) =>
            Effect.map(
              Effect.andThen(
                state.wait ? Queue.take(woken) : Effect.void,
                store.read(state.cursor, limit),
              ),
              (answered) =>
                [
                  [answered],
                  Option.some({ cursor: answered.cursor, wait: !answered.hasMore }),
                ] as const,
            ),
          ),
        ),
      ),
  };
};
