import {
  Array as Arr,
  type Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Stream,
} from "effect";
import type * as Event from "./Event.js";
import { attachmentsOf, type Checking, Events, reaches } from "./hub.js";
import type { Entry, Log, Logged, Read } from "./log.js";
import { Anyone } from "./caller.js";
import { jsonRoundTrip } from "./call.js";
import { canonicalInput } from "./canonical.js";
import { Unauthenticated } from "./errors.js";
import {
  builderLayer,
  type ErasedAuthorize,
  type ErasedValue,
  type Memoized,
  memoized,
  notMadeHere,
  type Protected,
  type Served,
  selectHeld,
} from "./implementation.js";
import { type Leases, makeLeases } from "./lease.js";
import { AnyOccurrence, Gap } from "./occurrence.js";
import { type Fed, fedOf, type Page, pagedFrom } from "./pages.js";
import { assertKnown } from "./names.js";
import { reported } from "./reported.js";

type ErasedOccurrence = Event.Occurrence<Event.Any>;

/**
 * An implemented event type, behind its authorizer, as a surface serves it: a poll, whose
 * subscription `subscriber` names, such as its principal, and a stream, which lasts as long as it
 * is read. Both authenticate and authorize the subscriber first, and run as it.
 */
export interface Feed {
  readonly event: Event.Any;
  /** Whether its source is a log fed by `emit`, which feeds it only while a build holds it. */
  readonly emits: boolean;
  /**
   * Releases the `subscription` hook `subscriber`'s polls of `input` hold: present exactly where
   * its source has a hook, held per subscriber.
   */
  readonly release?: ((input: ErasedValue, subscriber: string) => Effect.Effect<void>) | undefined;
  /** Authenticates and authorizes the subscriber, as `poll` and `stream` do first. */
  readonly admit: Effect.Effect<void, unknown, unknown>;
  readonly poll: (
    input: ErasedValue,
    cursor: string | null,
    options: PollOptions,
  ) => Effect.Effect<Page, unknown, unknown>;
  /**
   * Admits the subscriber, then reads the feed from a cursor, as often as a subscription
   * reopens it.
   */
  readonly stream: (
    input: ErasedValue,
  ) => Effect.Effect<
    (cursor: string | null) => Stream.Stream<Fed, unknown, unknown>,
    unknown,
    unknown
  >;
}

/** Who polls, and how many occurrences at most a log source's page holds. */
export interface PollOptions {
  readonly subscriber?: string | undefined;
  /** Capped at the page a log source reads anyway; a check's page is answered whole. */
  readonly maxEvents?: number | undefined;
}

interface Run extends Omit<Feed, "event" | "stream" | "admit"> {
  readonly stream: (
    input: ErasedValue,
    cursor: string | null,
  ) => Stream.Stream<Fed, unknown, unknown>;
}

type ErasedSource = Event.Source<Event.Any, unknown>;

/**
 * Each event of an implementation with what runs its source, each built on its own over the
 * implementation's one builder, so a selection runs only the sources of the events it holds.
 */
export type Running<E = unknown, R = unknown> = ReadonlyArray<
  readonly [Event.Any, Memoized<Run, E, R>]
>;

export const defaultNextPoll = Duration.seconds(5);

// Why: A page's wait goes on the wire as finite milliseconds, so `Duration.infinity`, which a
// check source answering "read me only when notified" may give, would fail every poll's answer.
const longestNextPoll = Duration.minutes(5);

const logPageSize = 100;

// Why: A check's page is the source's, whose cursor is the page's alone, so only a log source,
// read by sequence, can stop a page early and resume from where it stopped.
const pageLimit = (maxEvents: number) => Math.min(Math.max(Math.floor(maxEvents), 1), logPageSize);

// Why: An id generated only when the source gives none: one the source gives, such as an
// upstream's own, is what lets a subscriber deduplicate a replay. Its data is checked once, here,
// through its JSON, so every surface sends, and a watch in process receives, what a client
// decodes. An occurrence whose data breaks its schema is reported and a `Gap` sent in its place,
// so a subscriber reads on past it, as a poll answers the rest of its page: a check's occurrences
// before a page's last share the page's cursor, so failing the read would resume at the same
// page, failing again.
const occurrencesOf = (event: Event.Any) => {
  const sent = jsonRoundTrip(event.payload);

  return (
    emitted: Event.Emitted<Event.Any>,
    cursor: string | null,
  ): Effect.Effect<ErasedOccurrence | Gap> =>
    Effect.matchCauseEffect(sent(emitted.data), {
      onFailure: (cause) =>
        Effect.as(Effect.annotateLogs(reported(cause), "event", event.name), Gap.make({ cursor })),
      onSuccess: ({ value }) =>
        Effect.map(DateTime.now, (now) =>
          AnyOccurrence.make({
            eventId: emitted.eventId ?? globalThis.crypto.randomUUID(),
            name: event.name,
            timestamp: emitted.timestamp ?? now,
            data: value,
            cursor,
          }),
        ),
    });
};

const isOccurrence = (fed: Fed): fed is ErasedOccurrence => Predicate.isTagged(fed, "Occurrence");

/** A poll's page of `items`: their occurrences, `truncated` too where a gap stands for one. */
const pageOf = (
  items: ReadonlyArray<ErasedOccurrence | Gap>,
  { truncated, ...page }: Omit<Page, "events">,
): Page => {
  const events = items.filter(isOccurrence);

  return { ...page, events, truncated: truncated || events.length < items.length };
};

const lifted = <A, R>(value: A | Effect.Effect<A, never, R>): Effect.Effect<A, never, R> =>
  Effect.isEffect(value) ? value : Effect.succeed(value);

/** The key a subscriber of `input` is reached by, as the source's `key` answers it. */
const keyOf = (source: ErasedSource, input: ErasedValue) =>
  source.key === undefined
    ? Effect.succeed<string | undefined>(undefined)
    : lifted(source.key(input));

// Why: Each source holds leases of its own, so a subscriber and an input are a lease's key.
const leaseKey = (event: Event.Any, subscriber: string | undefined, input: ErasedValue) =>
  Effect.map(
    canonicalInput(event.input, input),
    (encoded) => `${subscriber ?? ""}\u0000${encoded}`,
  );

const checkRun = (
  event: Event.Any,
  source: Event.Check<Event.Any, unknown>,
  { wakes, polls }: Checking,
): Run => {
  const occurrenceOf = occurrencesOf(event);

  // Why: A stream yields a skipped occurrence's `Gap` in its place, at the cursor the page was
  // asked for, so a resume from it reads the rest of the page again; a poll's page, holding
  // occurrences alone, says it as `truncated`.
  const read = (input: ErasedValue, cursor: string | null) =>
    Effect.flatMap(source.check(input, cursor), (answered) =>
      Effect.map(
        Effect.forEach(answered.events, (emitted, index) =>
          // Why: A check's cursor is the page's: an occurrence before the last resumes from the
          // cursor the page was asked for, which replays rather than skips what follows it. On a
          // truncated page that cursor is no longer served, so resuming there reads a gap again:
          // the honest answer, as the rest of the page has no position of its own to skip to.
          occurrenceOf(emitted, index === answered.events.length - 1 ? answered.cursor : cursor),
        ),
        (items) => ({ answered, items }),
      ),
    );

  const answeredPage = ({
    answered,
    items,
  }: {
    readonly answered: Event.Page<Event.Any>;
    readonly items: ReadonlyArray<ErasedOccurrence | Gap>;
  }): Page =>
    pageOf(items, {
      cursor: answered.cursor,
      truncated: answered.truncated === true,
      hasMore: answered.hasMore === true,
      nextPoll: Duration.min(
        Duration.fromInputUnsafe(answered.nextPoll ?? defaultNextPoll),
        longestNextPoll,
      ),
    });

  return {
    emits: false,
    poll: (input, cursor) => Effect.map(read(input, cursor), answeredPage),
    // Why: The waiter is held before the first read, so a notify while it runs reads again at
    // once rather than at the next poll.
    stream: (input, cursor) =>
      Stream.unwrap(
        Effect.map(Effect.flatMap(keyOf(source, input), wakes), (woken) =>
          pagedFrom(
            (at) =>
              Effect.map(read(input, at), (delivered) => ({
                ...answeredPage(delivered),
                fed: fedOf({
                  items: delivered.items,
                  truncated: delivered.answered.truncated === true,
                  from: at,
                  to: delivered.answered.cursor,
                }),
              })),
            cursor,
            woken,
            polls,
          ),
        ),
      ),
  };
};

// Why: The revision is read before the value: a value written between them is read with an
// older revision, so the next read, at the revision its notify moved, sends it again, where the
// other order would pair an older value with the newer revision and never send the change.
const currentRun = (
  event: Event.Any,
  source: Event.Current<Event.Any, unknown>,
  checking: Checking,
): Run =>
  checkRun(
    event,
    {
      key: source.key,
      check: (input, cursor) =>
        Effect.gen(function* () {
          const at = yield* checking.revision(yield* keyOf(source, input));

          if (cursor === at) return { cursor: at, events: [] };

          return { cursor: at, events: [{ eventId: at, data: yield* source.current(input) }] };
        }),
    },
    checking,
  );

const logRun = (
  event: Event.Any,
  source: Event.Log<Event.Any, unknown>,
  log: Log<Event.Emitted<Event.Any>>,
): Run => {
  const occurrenceOf = occurrencesOf(event);

  const delivered = (
    input: ErasedValue,
    key: string | undefined,
    { cursor, at, value: logged }: Entry<Logged<Event.Emitted<Event.Any>> | undefined>,
  ): Effect.Effect<ErasedOccurrence | Gap | undefined, never, unknown> =>
    Effect.gen(function* () {
      // Why: An entry its storage could not read is a gap at its cursor, before any of the
      // source's callbacks, which are owed the data it was published with.
      if (logged === undefined) {
        yield* Effect.annotateLogs(
          Effect.logWarning(
            `An entry of the log of ${event.name} could not be read: sent as a gap`,
          ),
          "event",
          event.name,
        );

        return Gap.make({ cursor });
      }

      const emitted = logged.value;

      if (!reaches(logged.key, key)) return undefined;

      if (source.match !== undefined && !(yield* lifted(source.match(input, emitted.data)))) {
        return undefined;
      }

      const data =
        source.transform === undefined
          ? emitted.data
          : yield* lifted(source.transform(input, emitted.data));

      // Why: An entry's id and time are fixed when it was appended, so every read and every
      // subscriber receive the same: a replay is deduplicated, and stamped when it happened. The
      // cursor is unique, its epoch changing with each log.
      return yield* occurrenceOf(
        {
          data,
          eventId: emitted.eventId ?? cursor,
          timestamp: emitted.timestamp ?? DateTime.makeUnsafe(at),
        },
        cursor,
      );
    });

  // Why: An entry the subscriber does not reach or match sends nothing: the read's closing
  // `Checked` moves the position past it, so an `inOrder` push sends one per read, not one
  // per skipped entry of a busy log.
  const received = (
    input: ErasedValue,
    key: string | undefined,
    read: Read<Logged<Event.Emitted<Event.Any>> | undefined>,
  ) =>
    Effect.map(
      Effect.forEach(read.entries, (entry) => delivered(input, key, entry)),
      (items) => items.filter(Predicate.isNotUndefined),
    );

  return {
    emits: source.log.emit !== undefined,
    poll: (input, cursor, { maxEvents = logPageSize }) =>
      Effect.flatMap(
        Effect.all([keyOf(source, input), log.read(cursor, pageLimit(maxEvents))]),
        ([key, read]) =>
          Effect.map(received(input, key, read), (items) =>
            pageOf(items, {
              cursor: read.cursor,
              truncated: read.truncated,
              hasMore: read.hasMore,
              nextPoll: defaultNextPoll,
            }),
          ),
      ),
    stream: (input, cursor) =>
      Stream.unwrap(
        Effect.map(keyOf(source, input), (key) =>
          log.follow(cursor, logPageSize).pipe(
            Stream.mapEffect((read) =>
              Effect.map(received(input, key, read), (items) =>
                fedOf({ items, truncated: read.truncated, from: read.after, to: read.cursor }),
              ),
            ),
            Stream.flattenIterable,
          ),
        ),
      ),
  };
};

/** `run` with the source's `subscription` held while each subscription lasts. */
const hooked = (
  event: Event.Any,
  run: Run,
  subscription: NonNullable<ErasedSource["subscription"]>,
  leases: Leases,
): Run => ({
  ...run,
  poll: (input, cursor, options) =>
    Effect.flatMap(leaseKey(event, options.subscriber, input), (key) =>
      Effect.andThen(leases.hold(key, input), () => run.poll(input, cursor, options)),
    ),
  release: (input, subscriber) =>
    Effect.flatMap(leaseKey(event, subscriber, input), leases.release),
  stream: (input, cursor) =>
    Stream.unwrap(Effect.map(subscription(input), () => run.stream(input, cursor))),
});

const isCheck = (source: ErasedSource): source is Event.Check<Event.Any, unknown> =>
  Predicate.isFunction(source.check);

const isCurrent = (source: ErasedSource): source is Event.Current<Event.Any, unknown> =>
  Predicate.isFunction(source.current);

const runOf = (event: Event.Any, source: ErasedSource): Effect.Effect<Run, never, unknown> =>
  Effect.gen(function* () {
    const attach = yield* Effect.flatMap(Events, attachmentsOf);

    const run = isCheck(source)
      ? checkRun(event, source, yield* attach.check(event, false))
      : isCurrent(source)
        ? currentRun(event, source, yield* attach.check(event, true))
        : logRun(event, source, yield* attach.log(event, source.log, source.log.emit));

    if (source.subscription === undefined) return run;

    return hooked(
      event,
      run,
      source.subscription,
      yield* makeLeases(source.subscription, source.lease),
    );
  });

const isSource = (source: ErasedValue): source is ErasedSource => {
  const log: ErasedValue = Predicate.hasProperty(source, "log") ? source.log : undefined;

  const logged =
    Predicate.isObject(log) &&
    (!Predicate.hasProperty(log, "emit") || log.emit === undefined || Stream.isStream(log.emit));

  const given = [
    Predicate.isFunction(Predicate.hasProperty(source, "check") ? source.check : undefined),
    Predicate.isFunction(Predicate.hasProperty(source, "current") ? source.current : undefined),
    logged,
  ];

  return given.filter(Boolean).length === 1;
};

const assertSource = (event: Event.Any, source: ErasedValue): ErasedSource => {
  if (!isSource(source)) {
    throw new Error(
      `Event "${event.name}": its source needs exactly one of check, current or log (give check or current a function, or log its options, {} or { emit: stream })`,
    );
  }

  return source;
};

/**
 * The runtime of `events`' sources: one per event, from the source given for one event alone, or
 * from a record keyed by event name, the builder run once for all of them.
 */
export const sourcesOf = (
  events: ReadonlyArray<Event.Any>,
  single: boolean,
  sources: ErasedValue,
): Running => {
  const names = events.map((event) => event.name);

  const checked = (built: ErasedValue): Readonly<Record<string, ErasedValue>> => {
    const keyed: Readonly<Record<string, ErasedValue>> = single
      ? Object.fromEntries(names.map((name) => [name, built]))
      : Predicate.isObject(built)
        ? Object.fromEntries(Object.entries(built))
        : {};

    assertKnown("sources", Object.keys(keyed), names, "remove it, or list its event");

    const missing = names.filter((name) => !Object.hasOwn(keyed, name));

    if (missing.length > 0) {
      throw new Error(
        `Missing sources: ${missing.join(", ")} (give the source of one event, or a record with an own source per listed event)`,
      );
    }

    return keyed;
  };

  const built = memoized(
    Effect.isEffect(sources) ? Effect.map(sources, checked) : Effect.sync(() => checked(sources)),
  );

  // Why: each event's source attaches as a layer of its own over the one build, so a surface
  // serving a selection attaches only the sources it serves: an unselected log source fed by
  // `emit` never starts, nor dies where the host's `Events` consumes no `emit`.
  return events.map((event) => {
    const run = memoized(
      Effect.flatMap(Effect.service(built.key), (keyed) =>
        runOf(event, assertSource(event, keyed[event.name])),
      ),
    );

    return [event, { key: run.key, layer: Layer.provide(run.layer, built.layer) }] as const;
  });
};

/**
 * Event types bound to their sources and their authorizer: everything one `Event.implement` call
 * produced. Its type parameters may be written out, as a package emitting declarations prints
 * them: `E` its event types, `R` what its sources read per subscription, by event name, `EX` and `RX` the
 * failures and services of its builder, `RA` what its authorizer reads per subscription, and
 * `EAX` and `RAX` the failures and services of the authorizer's builder.
 */
export class EventImplementation<
  E extends Event.Any,
  R,
  EX,
  RX,
  RA = never,
  EAX = never,
  RAX = never,
> {
  /** Tells an event implementation from an action implementation among what a surface is given. */
  readonly _tag = "EventImplementation";
  /** Type-only: what its sources read per subscription, by event name. */
  declare readonly "~eventRequest": R;
  /** Type-only: what building its sources fails with. */
  declare readonly "~eventBuildError": EX;
  /** Type-only: what building its sources needs. */
  declare readonly "~eventBuildServices": RX;
  /** Type-only: what its authorizer reads per subscription. */
  declare readonly "~eventAuthorizeRequest": RA;
  /** Type-only: what building its authorizer fails with. */
  declare readonly "~eventAuthorizeBuildError": EAX;
  /** Type-only: what building its authorizer needs. */
  declare readonly "~eventAuthorizeBuildServices": RAX;

  readonly #running: Running<EX, RX>;
  readonly #authorizer: Memoized<ErasedAuthorize<Event.Any>, EAX, RAX>;

  constructor(
    /** The event types this implementation answers. */
    readonly events: ReadonlyArray<E>,
    running: Running<EX, RX>,
    authorizer: Memoized<ErasedAuthorize<Event.Any>, EAX, RAX>,
  ) {
    this.#running = running;
    this.#authorizer = authorizer;
  }

  /** Select event types while retaining their sources, authorization and shared builder. */
  static share(
    events: ReadonlyArray<Event.Any>,
    app: AnyEventImplementation,
  ): AnyEventImplementation {
    const source = EventImplementation.own(app);

    return new EventImplementation(events, source.#running, source.#authorizer);
  }

  /** The builders of `app`, its sources' and its authorizer's, as one layer. */
  static layerOf(app: AnyEventImplementation): Layer.Layer<never, unknown, unknown> {
    const source = EventImplementation.own(app);

    const runs = EventImplementation.held(app).reduce<Layer.Layer<never, unknown, unknown>>(
      (layer, [, run]) => Layer.merge(layer, run.layer),
      Layer.empty,
    );

    return builderLayer(app.events, { layer: runs }, source.#authorizer);
  }

  /** The event types of `app` with what runs them, behind its authorizer. */
  static feedsOf(app: AnyEventImplementation): Effect.Effect<ReadonlyArray<Feed>, never, unknown> {
    const source = EventImplementation.own(app);

    return Effect.gen(function* () {
      const before = app.events.some((event) => event.caller !== Anyone)
        ? yield* source.#authorizer.key
        : () => Effect.void;

      return yield* Effect.forEach(EventImplementation.held(app), ([event, run]) =>
        Effect.map(Effect.service(run.key), (ran) => guarded(event, ran, before)),
      );
    });
  }

  /** What runs each event type `app` holds. */
  private static held(app: AnyEventImplementation): Running {
    return EventImplementation.own(app).#running.filter(([event]) => app.events.includes(event));
  }

  private static own<App extends AnyEventImplementation>(app: App): App {
    if (!(#running in app)) throw notMadeHere("Event");

    return app;
  }
}

/** Any event implementation, with its events and channels erased. */
export type AnyEventImplementation<E extends Event.Any = Event.Any> = EventImplementation<
  E,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown
>;

const guarded = (event: Event.Any, run: Run, before: ErasedAuthorize<Event.Any>): Feed => {
  const attributes = { "event.name": event.name };

  const admitted =
    event.caller === Anyone
      ? Effect.void
      : Effect.flatMap(Effect.serviceOption(event.caller), (subscriber) =>
          Option.isSome(subscriber)
            ? Effect.suspend(() => before(event))
            : Effect.fail(new Unauthenticated()),
        );

  return {
    event,
    emits: run.emits,
    release: run.release,
    admit: admitted,
    poll: (input, cursor, options) =>
      Effect.andThen(admitted, () => run.poll(input, cursor, options)).pipe(
        Effect.annotateLogs(attributes),
        Effect.withSpan(event.name, { attributes }, { captureStackTrace: false }),
      ),
    // Why: Admitted once, as the subscription starts: a surface reopening it after a source's
    // failure reads on under that admission, as a held stream does between reads, and a client's
    // reconnect is a new subscription, admitted again.
    stream: (input) =>
      Effect.as(admitted, (cursor: string | null) =>
        run.stream(input, cursor).pipe(Stream.withSpan(event.name, { attributes })),
      ),
  };
};

/** The event implementations among what a surface is given. */
export const eventsOf = (served: Served): ReadonlyArray<AnyEventImplementation> =>
  Arr.ensure(served).filter((app): app is AnyEventImplementation =>
    Predicate.isTagged(app, "EventImplementation"),
  );

/**
 * The event implementations among `apps` holding an event type of `listed`, each holding those
 * alone, refusing one listed that none holds; every one where `listed` is absent.
 */
export const selectEvents = (
  apps: ReadonlyArray<AnyEventImplementation>,
  listed: ReadonlyArray<Event.Any> | undefined,
): ReadonlyArray<AnyEventImplementation> =>
  selectHeld(
    apps,
    listed,
    (app) => app.events,
    (own, app) => EventImplementation.share(own, app),
  );

/** The builder layers of event implementations, as a surface provides them. */
export const feedBuilders = (
  events: ReadonlyArray<AnyEventImplementation>,
): ReadonlyArray<Layer.Layer<never, unknown, unknown>> =>
  events.map((app) => EventImplementation.layerOf(app));

/** Every feed of event implementations, from the context their builders provide. */
export const acquireFeeds = (
  events: ReadonlyArray<AnyEventImplementation>,
): Effect.Effect<ReadonlyArray<Feed>, never, unknown> =>
  Effect.map(
    Effect.forEach(events, (app) => EventImplementation.feedsOf(app)),
    (feeds) => feeds.flat(),
  );

/** The event types of the implementations `App`. */
export type EventOf<App> = App extends { readonly events: ReadonlyArray<infer E extends Event.Any> }
  ? E
  : never;

type IdentityOf<K> = K extends Context.Key<infer I, unknown> ? I : never;

type RequestOf<R, Name> = Name extends keyof R ? R[Name] : never;

/**
 * What a subscription of `E` owes per subscriber where the implementations `App` serve it: its
 * sources' services, and for a protected event its authorizer's and the subscriber's identity.
 */
export type EventRequestOf<App, E extends Event.Any> = App extends {
  readonly events: ReadonlyArray<infer Held>;
  readonly "~eventRequest": infer R;
  readonly "~eventAuthorizeRequest": infer RA;
}
  ? E extends Held
    ?
        | RequestOf<R, E["name"]>
        | (E["caller"] extends typeof Anyone ? never : RA | IdentityOf<E["caller"]>)
    : never
  : never;

/**
 * The event types of `App` a surface given the event types `Listed` serves, as `selectEvents`
 * selects them by identity: one whose type either is assignable to, or is assigned by, one
 * listed, so an implementation or a list typed wider than its event types still counts.
 */
export type ServingEvents<App, Listed extends Event.Any> =
  EventOf<App> extends infer E extends Event.Any
    ? E extends unknown
      ? [E] extends [Listed]
        ? E
        : [Extract<Listed, E>] extends [never]
          ? never
          : E
      : never
    : never;

/** The event implementations among `App` holding an event type of `Listed`: those a surface builds. */
export type HoldingEvents<App, Listed extends Event.Any> = App extends unknown
  ? [ServingEvents<App, Listed>] extends [never]
    ? never
    : App
  : never;

type ServesProtected<App, Listed extends Event.Any> = [
  Protected<ServingEvents<App, Listed>>,
] extends [never]
  ? false
  : true;

/** What building the event implementations `App` fails with, where their event types of `Listed` are served. */
export type EventBuildError<App, Listed extends Event.Any = EventOf<App>> = App extends {
  readonly "~eventBuildError": infer EX;
  readonly "~eventAuthorizeBuildError": infer EAX;
}
  ? [ServingEvents<App, Listed>] extends [never]
    ? never
    : EX | (ServesProtected<App, Listed> extends true ? EAX : never)
  : never;

/** What building the event implementations `App` reads at startup, where their event types of `Listed` are served. */
export type EventBuildServices<App, Listed extends Event.Any = EventOf<App>> = App extends {
  readonly "~eventBuildServices": infer RX;
  readonly "~eventAuthorizeBuildServices": infer RAX;
}
  ? [ServingEvents<App, Listed>] extends [never]
    ? never
    : RX | (ServesProtected<App, Listed> extends true ? RAX : never)
  : never;
