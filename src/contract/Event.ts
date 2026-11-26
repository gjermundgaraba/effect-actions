import {
  Array as Arr,
  Data,
  Effect,
  Match,
  Option,
  Predicate,
  Schema,
} from "effect";
import type { DateTime, Duration, Schedule, Scope, Stream } from "effect";

import type * as Action from "./Action.js";
import { authorizerOf } from "./authorizer.js";
import type { Deferred, ErasedAuthorizer } from "./authorizer.js";
import { Anyone, assertCaller } from "./caller.js";
import { codecOf } from "./codec.js";
import type { Codec, CodecOf, Fields, NoInput } from "./codec.js";
import type { Refusal, Unavailable } from "./errors.js";
import { EventImplementation, sourcesOf } from "./feed.js";
import type { Events, KeyOptions } from "./hub.js";
import type { ErasedValue, Protected } from "./implementation.js";
import { assertEventName, assertOnce } from "./names.js";
import type { Gap, OccurrenceSchema } from "./occurrence.js";

export type { EventImplementation as Implementation } from "./feed.js";

export { Events, layerMemory } from "./hub.js";

export type { KeyOptions } from "./hub.js";

export type { Listed } from "./log.js";

export type { AnyEventImplementation as AnyImplementation } from "./feed.js";

const TypeId = "~@gjermundgaraba/effect-actions/Event";

/** What `make` needs to define an event type. */
export interface Options {
  /**
   * Who may subscribe: `Action.Anyone`, or the identity service a subscriber must have, as an
   * action's `caller` says; the rules of an identity are on `Action.Options.caller`.
   */
  readonly caller: Action.Options["caller"];
  /** What happens when the event fires; a model and a CLI user read it beside the event's name. */
  readonly description: string;
  /**
   * The subscription's arguments, a schema or struct fields, as an action's `input` is: they may
   * filter the occurrences, shape them, or configure the subscription. Omit for an event without
   * arguments. Its rules are `Action.Options.input`'s.
   */
  readonly input?: Codec | Fields | undefined;
  /**
   * What each occurrence carries, a schema or struct fields: an object, since MCP sends it as an
   * occurrence's `data`.
   */
  readonly payload: Codec | Fields;
}

type OnlyOptions<O> = {
  readonly [
    K in Exclude<O extends unknown ? keyof O : never, keyof Options>
  ]: never;
};

type Rules<O> = Options extends O ? unknown : OnlyOptions<O>;

type InputOf<O> = O extends { readonly input?: infer I }
  ? | CodecOf<Extract<Exclude<I, undefined>, Codec | Fields>>
    | ([undefined] extends [I] ? typeof NoInput : never)
  : typeof NoInput;

type PayloadOf<O> = O extends {
  readonly payload: infer P extends Codec | Fields;
}
  ? CodecOf<P>
  : never;

/**
 * A pure contract for something that happens, bound to its source by `implement`: subscribers
 * receive its occurrences, each carrying a `payload`, filtered and shaped by the subscription's
 * `input`. Its `name`, `input` and `payload` are public: reuse them, as in
 * `Schema.Array(NoteCreated.payload)`.
 */
export interface Event<
  Name extends string,
  Input extends Codec,
  Payload extends Codec,
  Caller extends Options["caller"] = Options["caller"],
> {
  readonly [TypeId]: typeof TypeId;
  readonly caller: Caller;
  readonly name: Name;
  readonly description: string;
  /** The subscription's arguments as a schema, a `Schema.Struct` where fields were given. */
  readonly input: Input;
  /** What each occurrence carries, as a schema. */
  readonly payload: Payload;
}

/** Any event type, with its schemas erased. */
export type Any = Event<string, Codec, Codec>;

/** Whether `u` is an event type `make` defined: a binding's list tells events from actions by it. */
export const isEvent = (u: unknown): u is Any =>
  Predicate.hasProperty(u, TypeId);

/**
 * Define an event type: what a subscription takes, what each occurrence carries, and who may
 * subscribe. A surface serving it names it by `name`.
 * Guide: `docs/Event.md` in this package; in an application: `examples/build-events/src/builds/`.
 *
 * **Gotchas**
 *
 * - A name is lowercase segments joined by dots, `note.created`: its form is in the message `Invalid event name` throws; it is unique among the events each surface serves, apart from action names.
 * - Surfaces match an implementation to a contract by object identity, never by name, as for actions.
 */
export function make<const Name extends string, const O extends Options>(
  name: Name,
  options: O & NoInfer<Rules<O>>
): Event<Name, InputOf<O>, PayloadOf<O>, O["caller"]>;
export function make(name: string, options: Options): Any {
  assertEventName(name);

  const { caller } = options;

  assertCaller(caller);

  if (options.payload === undefined) {
    throw new Error(
      `Missing payload: event "${name}" (declare what each occurrence carries)`
    );
  }

  return {
    [TypeId]: TypeId,
    caller,
    name,
    description: options.description,
    input: codecOf(options.input ?? {}),
    payload: codecOf(options.payload),
  };
}

/**
 * One occurrence as a source produces it: its `data`, and optionally the upstream's own id, which
 * subscribers deduplicate by, and when it happened. Without them, a log source's occurrence
 * takes its cursor as its id and the time it was appended, the same on every read; a check's
 * takes a generated id and the time it is read.
 */
export interface Emitted<E extends Any> {
  readonly data: E["payload"]["Type"];
  /**
   * A stable id: give the upstream's own, such as a message or delivery id, so a retry or a replay repeats it.
   *
   * **Gotchas**
   *
   * - An id given again for another occurrence is dropped as a duplicate by a `watch` and by `Webhook.layerReceiver`, each keeping its last 1,000: an id from a counter that restarts with the process repeats, so leave it out rather than give one.
   */
  readonly eventId?: string | undefined;
  readonly timestamp?: DateTime.Utc | undefined;
}

/**
 * What a check answers for a cursor: the occurrences since it, and the cursor after them.
 *
 * **Gotchas**
 *
 * - A cursor the upstream no longer serves, such as one older than its retention, is answered with `truncated: true` and a fresh cursor: the subscriber then knows it missed occurrences.
 * - A `nextPoll` under a second is read as a second, and one over 5 minutes, `Duration.infinity` included, as 5 minutes, by the server's loop and by a polling client alike.
 */
export interface Page<E extends Any> {
  readonly events: ReadonlyArray<Emitted<E>>;
  readonly cursor: string;
  readonly truncated?: boolean | undefined;
  /** More occurrences are ready: the subscriber asks again without waiting. */
  readonly hasMore?: boolean | undefined;
  /**
   * How long a subscriber waits before it asks again, a `notified` source's streams and webhooks
   * excepted; defaults to 5 seconds.
   */
  readonly nextPoll?: Duration.Input | undefined;
}

interface Hooked<E extends Any, R> {
  readonly subscription?:
    | ((
        input: E["input"]["Type"]
      ) => Effect.Effect<void, never, R | Scope.Scope>)
    | undefined;
  readonly lease?: Duration.Input | undefined;
  readonly key?:
    | ((
        input: E["input"]["Type"]
      ) => string | undefined | Effect.Effect<string | undefined, never, R>)
    | undefined;
}

/**
 * An event type read from an upstream that can be asked what happened since a cursor, such as a
 * change feed or a history API: one function answers every subscriber, whatever the surface.
 *
 * **Gotchas**
 *
 * - An occurrence without `eventId` takes a fresh id at each read, and a page's occurrences before its last are read again from the cursor asked after a reconnect mid-page: give the upstream's ids, or a subscriber receives them again under ids no `watch` drops.
 * - A read that fails for a while, such as its store being down, fails with `Action.Unavailable`, which a watch reads on after as after any failure no refusal explains, and an HTTP poll is answered 503 with `Retry-After`; a refusal such as `Forbidden` ends the watch.
 */
export interface Check<E extends Any, R = never> extends Hooked<E, R> {
  /**
   * What happened since `cursor`, as the subscriber's `input` selects it, run as the subscriber.
   * A `null` cursor is a subscriber with no position: answer nothing, so it starts after the last
   * occurrence. An event whose occurrence is the whole value, such as a status, is a `Current`.
   */
  readonly check: (
    input: E["input"]["Type"],
    cursor: string | null
  ) => Effect.Effect<Page<E>, Refusal | Unavailable, R>;
  /**
   * Every change `check` reads is announced by an `Events.notify` the server serving it receives,
   * as a store only that server's handlers write is: its streams and webhook deliveries then ask
   * `check` again only when notified, on no timer, so an idle Cloudflare Durable Object holding
   * them hibernates. Defaults to `false`, asking again at each page's `nextPoll` too. A polling
   * client polls at `nextPoll` either way, and an rpc's poll page says `notified`, so a host that
   * holds polls, as the Cloudflare package's socket host does, holds one of this source alone.
   *
   * **Gotchas**
   *
   * - A change no `notify` on that server announces, as another server's write to a shared database or an upstream's own, reaches its streams, its webhooks and a poll a host holds only with the next `notify`.
   * - A `notify` that `check` runs before it can read the write waits for the next `notify` too: notify after the write commits, or inside its transaction only where `check` reads through the same connection, as one SQLite client's reads wait for its transaction.
   */
  readonly notified?: boolean | undefined;
  readonly log?: never;
  readonly current?: never;
}

/** What `appended` reads after a position: the entries past it, oldest first. */
export interface Appended<E extends Any> {
  /** The occurrences' data, oldest first: none where every entry read was skipped. */
  readonly items: ReadonlyArray<E["payload"]["Type"]>;
  /**
   * The id of the last entry read, where it is not the last item's, as where entries read are
   * skipped: the next read goes on after it.
   *
   * **Gotchas**
   *
   * - One below the last item's id is read as the last item's, so no item is sent twice.
   * - One past `newest` makes the next read answer `truncated: true` and the newest id, a gap the subscriber never had.
   */
  readonly through?: number | undefined;
  /**
   * More entries are ready past `through`: the subscriber reads again without waiting. Ignored on a
   * read that moved the cursor nowhere, which would read the same entries again at once forever.
   */
  readonly hasMore?: boolean | undefined;
}

/** What `appended` needs to page a store appending entries under increasing integer ids. */
export interface AppendedOptions<
  E extends Any,
  RN = never,
  RA = never,
  RK = never,
  RS = never,
> extends Pick<Check<E>, "notified" | "lease"> {
  /** The id of the newest entry, `0` while there is none, run as the subscriber. */
  readonly newest: (
    input: E["input"]["Type"]
  ) => Effect.Effect<number, Refusal | Unavailable, RN>;
  /** The entries after `id`, oldest first, as many as one read takes, run as the subscriber. */
  readonly after: (
    input: E["input"]["Type"],
    id: number
  ) => Effect.Effect<Appended<E>, Refusal | Unavailable, RA>;
  /** The id of the entry an occurrence's data was read from: its `eventId`, and a cursor. */
  readonly id: (data: E["payload"]["Type"]) => number;
  /** Each page's `nextPoll`; defaults to 5 seconds. */
  readonly nextPoll?: Duration.Input | undefined;
  readonly key?: Hooked<E, RK>["key"];
  readonly subscription?: Hooked<E, RS>["subscription"];
}

const appendedId = (cursor: string | null): Option.Option<number> => {
  const id = Number(cursor);

  return cursor !== null &&
    Number.isSafeInteger(id) &&
    id >= 0 &&
    String(id) === cursor
    ? Option.some(id)
    : Option.none();
};

/**
 * A check source for a store that appends entries under increasing integer ids, such as a table's
 * `INTEGER PRIMARY KEY`: its cursor is the id of the last entry a subscriber read, and an
 * occurrence's `eventId` its entry's id. A new subscriber starts after the newest entry. `event`
 * types the options alone, as `Event.appended(MessagePosted, { … })` in `implement`'s builder.
 *
 * **Gotchas**
 *
 * - A cursor that is not an id up to `newest`'s as the check spells one, digits without a sign, exponent or leading zero, such as another store's or one past a store emptied since, is answered with `truncated: true` and the newest id: the subscriber goes on from there.
 * - A store deleting its oldest entries sends no gap for those a subscriber resuming before them missed: a cursor is stale only past `newest`.
 * - Ids that start again, as a store kept in memory restarts them, make an old cursor read entries it never saw as the ones after it: such a store's cursor carries its epoch in a `check` of its own.
 */
export const appended = <
  E extends Any,
  RN = never,
  RA = never,
  RK = never,
  RS = never,
>(
  _event: E,
  { newest, after, id, nextPoll, ...source }: AppendedOptions<E, RN, RA, RK, RS>
): Check<E, RN | RA | RK | RS> => ({
  ...source,
  check: (input, cursor) =>
    Effect.gen(function* () {
      const last = yield* newest(input);
      const from = Option.filter(appendedId(cursor), (at) => at <= last);

      if (Option.isNone(from)) {
        return {
          events: [],
          cursor: String(last),
          truncated: cursor !== null,
          nextPoll,
        };
      }

      if (from.value === last) {
        return { events: [], cursor: String(last), nextPoll };
      }

      const read = yield* after(input, from.value);
      const lastItem = read.items.at(-1);
      const reached = lastItem === undefined ? from.value : id(lastItem);
      const through = Math.max(read.through ?? reached, reached);

      return {
        events: read.items.map((data) => ({ eventId: String(id(data)), data })),
        cursor: String(through),
        hasMore: read.hasMore === true && through > from.value,
        nextPoll,
      };
    }),
});

/**
 * An event type whose occurrence is the whole value, such as a status or a list small enough to
 * send whole: a subscriber receives the value as it is first, then again after each
 * `Events.notify` that reaches it and changes it, never a change it missed one by one. The
 * library keeps a revision per key, which each such notify moves; the revision and a digest of
 * the subscription's input, its key and the value sent make the cursor and each occurrence's id.
 * Its streams and webhook deliveries read it again only when notified, on no timer, so an idle
 * Cloudflare Durable Object holding them hibernates; a polling client polls at `nextPoll`.
 *
 * **Gotchas**
 *
 * - A notify reads the value again for each subscriber it reaches, though a value equal to the one its cursor saw, for the same input and key, is not sent: notify after a write that may change it, not on a timer.
 * - The revision is read before `current`, so a value written between them is read again at the next read, never missed: write the value, then notify.
 * - A cursor is its subscription's own: one taken to another input of the same key, at a revision it already holds, is answered with nothing until the next notify.
 * - A read that fails for a while, such as its store being down, fails with `Action.Unavailable`, which a watch reads on after as after any failure no refusal explains, and an HTTP poll is answered 503 with `Retry-After`; a refusal such as `Forbidden` ends the watch.
 */
export interface Current<E extends Any, R = never> extends Hooked<E, R> {
  /** The value as it is, as the subscriber's `input` selects it, run as the subscriber. */
  readonly current: (
    input: E["input"]["Type"]
  ) => Effect.Effect<E["payload"]["Type"], Refusal | Unavailable, R>;
  /**
   * How long a polling client waits before it asks again, read in the bounds of `Page`'s
   * `nextPoll`; defaults to 5 seconds. Streams and webhook deliveries never wait on it: they read
   * when notified.
   */
  readonly nextPoll?: Duration.Input | undefined;
  readonly check?: never;
  readonly log?: never;
}

/**
 * An event type whose occurrences the library keeps as they are announced, for an upstream with
 * no history of its own: `Events.publish` appends each, and `log.emit`, where given, a stream of
 * them. Each subscriber receives the occurrences its `match` accepts, shaped by its `transform`.
 *
 * **Gotchas**
 *
 * - A cursor is only good where the log that minted it lives, for as long as it keeps its occurrences: once they are dropped, or after a restart under `Event.layerMemory`, a subscriber resuming from it receives `truncated` and a fresh cursor; `Stored.layerEvents` keeps a log across a restart on the same database.
 * - A subscriber reading slower than occurrences arrive falls behind the log like a resumed one: it receives `truncated`, never a backlog held for it alone.
 * - An `emit` stream is consumed from startup, in the server's scope, by one build at a time, until it ends, even past its build's release: a failure ends it and is reported, an end is logged, and the next held build's stream, if any, takes over; the log then holds what was published.
 * - A cluster entity refuses an `emit` stream, its activation dying as it builds: Effect's entity reaper stops an entity while its stream runs, and what the stream sends meanwhile is lost; append with `Events.publish` from a handler.
 */
export interface Log<E extends Any, R = never> extends Hooked<E, R> {
  /** What the log keeps, and the stream feeding it besides `Events.publish`; `{}` for none. */
  readonly log: LogOptions<E>;
  /** Whether a subscriber of `input` receives an occurrence carrying `data`; defaults to every one. */
  readonly match?:
    | ((
        input: E["input"]["Type"],
        data: E["payload"]["Type"]
      ) => boolean | Effect.Effect<boolean, never, R>)
    | undefined;
  /** The data a subscriber of `input` receives in place of `data`, such as one with fields removed. */
  readonly transform?:
    | ((
        input: E["input"]["Type"],
        data: E["payload"]["Type"]
      ) => E["payload"]["Type"] | Effect.Effect<E["payload"]["Type"], never, R>)
    | undefined;
  readonly check?: never;
  readonly current?: never;
}

/** What a log source keeps, and what feeds it besides `Events.publish`. */
export interface LogOptions<E extends Any> {
  /**
   * A stream of occurrences, such as a message bus's, appended as they arrive from startup, each
   * reaching the subscribers of its `key`, as `Events.publish` given one does.
   */
  readonly emit?: Stream.Stream<Emitted<E> & KeyOptions> | undefined;
  /**
   * How long an occurrence is kept for subscribers resuming from a cursor; defaults to 10 minutes.
   * The first build attached to its log sets it, and later builds share that log.
   */
  readonly maxAge?: Duration.Input | undefined;
  /**
   * How many occurrences are kept at most, of every key together; defaults to 10,000.
   *
   * **Gotchas**
   *
   * - A busy key drops a quiet one's occurrences too: a subscriber of the quiet key resuming after them receives a gap, though none of its own was dropped.
   */
  readonly maxEvents?: number | undefined;
}

/** Where an event type's occurrences come from: exactly one of `check`, `current` or `log`. */
export type Source<E extends Any, R = never> =
  | Check<E, R>
  | Current<E, R>
  | Log<E, R>;

/**
 * One occurrence as a subscriber receives it: `eventId`, the source's id or one generated, which
 * a subscriber deduplicates by; `cursor`, where to resume after it, `null` for an event type that
 * cannot be resumed.
 */
export type Occurrence<E extends Any> = OccurrenceSchema<E>["Type"];

export { Gap } from "./occurrence.js";

/** What a subscriber receives: occurrences, and gaps where it missed some, told apart by `_tag`, `"Occurrence"` or `"Gap"`. */
export type Received<E extends Any> = Occurrence<E> | Gap;

/** The server serves no event type of that name, or no longer does. */
export class NotServed extends Schema.TaggedError<
  NotServed,
  { readonly brand: unique symbol }
>()("NotServed", {}) {}

/**
 * The server serves the event type, but not as asked: `feature` names what it does not offer,
 * such as `deliveryMode`, and `value` which one, such as `push`.
 */
export class Unsupported extends Schema.TaggedError<
  Unsupported,
  { readonly brand: unique symbol }
>()("Unsupported", {
  feature: Schema.String,
  value: Schema.optional(Schema.String),
}) {}

/**
 * Why a webhook's callback endpoint failed, in SEP-3415's categories: it refused the connection
 * or was unreachable, timed out, failed TLS, answered a status from 300 to 499 (`http_4xx`, as
 * the categories name no 3xx) or a 5xx, or did not echo the verification challenge.
 */
export const CallbackCategory = Schema.Literals([
  "connection_refused",
  "timeout",
  "tls_error",
  "http_4xx",
  "http_5xx",
  "challenge_failed",
]);

export type CallbackCategory = typeof CallbackCategory.Type;

/** A webhook subscription's callback endpoint failed its verification, or was unreachable. */
export class CallbackFailed extends Schema.TaggedError<
  CallbackFailed,
  { readonly brand: unique symbol }
>()("CallbackFailed", {
  category: CallbackCategory,
}) {}

/** No webhook subscription matches the one an unsubscribe names. */
export class NotSubscribed extends Schema.TaggedError<
  NotSubscribed,
  { readonly brand: unique symbol }
>()("NotSubscribed", {}) {}

const Reason = Schema.Union([
  NotServed,
  Unsupported,
  CallbackFailed,
  NotSubscribed,
]);

const sentenceOf = Match.typeTags<(typeof Reason)["Type"], string>()({
  NotServed: () => "is not served",
  Unsupported: ({ feature, value }) =>
    `is not served with this ${feature}${value === undefined ? "" : `: ${value}`}`,
  CallbackFailed: ({ category }) =>
    `could not reach its webhook's callback: ${category}`,
  NotSubscribed: () => "has no such webhook subscription",
});

/**
 * A subscription that cannot start or go on: `reason` says why, so a subscriber branches on it
 * with `Effect.catchReason("SubscriptionError", "NotServed", ...)`; `message` names the event and
 * the reason. A refusal is `Action.Unauthenticated` or `Action.Forbidden`, and input that does not
 * decode `Action.InvalidInput`, as for an action.
 */
export class SubscriptionError extends Schema.TaggedError<
  SubscriptionError,
  { readonly brand: unique symbol }
>()(
  "SubscriptionError",
  { event: Schema.String, reason: Reason, message: Schema.String },
  { httpApiStatus: 409 }
) {
  /** The error for `event` failing with `reason`, its message built from both. */
  static of(event: string, reason: (typeof Reason)["Type"]): SubscriptionError {
    return new SubscriptionError({
      event,
      reason,
      message: `Event "${event}" ${sentenceOf(reason)}`,
    });
  }
}

/**
 * Where a watch keeps its cursor: what it kept under a key, and keeping a new one; a failure `E`
 * of either ends the watch with it.
 */
export interface CursorStore<E = never> {
  readonly get: (key: string) => Effect.Effect<string | undefined, E>;
  readonly set: (key: string, cursor: string) => Effect.Effect<void, E>;
}

/** A `CursorStore` in memory, which `memoryCursors` makes. */
export interface MemoryCursors extends CursorStore {
  readonly _tag: "MemoryCursors";
}

/**
 * A `CursorStore` in memory, for as long as it is referenced: give a watch one of its own,
 * `resume: { store: Event.memoryCursors() }`, which takes no `key`, so a retry of the watch's
 * stream goes on where the failed run stopped; a restart starts from now.
 *
 * **Gotchas**
 *
 * - One store given to two watches without a `key` keeps one cursor for both, so each resumes from the other's and misses occurrences: make one per watch.
 */
export const memoryCursors = (): MemoryCursors => {
  const cursors = new Map<string, string>();

  return {
    _tag: "MemoryCursors",
    get: (key) => Effect.sync(() => cursors.get(key)),
    set: (key, cursor) =>
      Effect.sync(() => {
        cursors.set(key, cursor);
      }),
  };
};

/**
 * A watch delivered by webhook, which `Webhook.delivery` makes: the server POSTs each occurrence
 * to the route `Webhook.layerReceiver` serves in the watching process, reached under `baseUrl`,
 * for as long as the watch is read, each grant asking for `ttl`.
 */
export class WebhookDelivery extends Data.TaggedClass("WebhookDelivery")<{
  /**
   * The https URL the server reaches the watching process at: its `layerReceiver` route's path
   * is appended to it, `https://notifier.example.com` with `/hooks/builds` delivering to
   * `https://notifier.example.com/hooks/builds`.
   */
  readonly baseUrl: string;
  /** The lifetime each subscribe asks for; omitted, the server's longest. */
  readonly ttl?: Duration.Input | undefined;
}> {}

/**
 * How a client watches an event type; `E` is what its `resume` store fails with.
 *
 * **Gotchas**
 *
 * - Each run of a watch's stream starts from these options, a retry or a repeat included: to go on where a failed run stopped, give `resume`, which every run reads.
 * - `resume` keeps an occurrence's cursor once the next is pulled, so a consumer stopped while handling one receives it again: deduplicate by `eventId` where that matters.
 */
export interface WatchOptions<E = never> {
  /** Where to start: a cursor an occurrence or a gap carried; defaults to now. */
  readonly cursor?: string | null | undefined;
  /**
   * `"stream"` holds one subscription open, `"poll"` asks again and again, and a
   * `Webhook.delivery` has the server POST each occurrence to a receiver this process serves,
   * which the watch then requires; left out, a watch streams where its surface can and polls
   * where the server serves the event by poll alone.
   */
  readonly mode?: "stream" | "poll" | WebhookDelivery | undefined;
  /**
   * Where to keep the cursor between watches, such as across restarts: it starts from the cursor
   * kept under `key`, when no `cursor` is given, and keeps each new one there. Effect's
   * `KeyValueStore` is one: `{ store: yield* KeyValueStore.KeyValueStore, key: "builds" }`; a
   * store of the watch's own, `memoryCursors()`, takes no `key`.
   */
  readonly resume?:
    | { readonly store: CursorStore<E>; readonly key: string }
    | { readonly store: MemoryCursors; readonly key?: string | undefined }
    | undefined;
  /**
   * Bounds a watch's reconnects after failures it retries, such as a dropped stream or an
   * `Unavailable`: with `Schedule.recurs(5)`, the sixth failure in a row ends the watch with it.
   * Between reconnects the watch waits the longer of the schedule's delay and its own backoff;
   * left out, it reconnects without end.
   *
   * **Gotchas**
   *
   * - The count starts again at anything the watch receives, a stream's 30-second heartbeat included, so it bounds failures in a row, not a watch's lifetime.
   */
  readonly reconnect?: Schedule.Schedule<unknown> | undefined;
}

/**
 * Authorization for protected event types: it refuses, and fails with nothing else. It runs for
 * every subscription of a protected event type, before its source.
 */
export type Authorize<E extends Any, R = never> = (
  event: E
) => Effect.Effect<void, Refusal, R>;

/** Every authenticated subscriber may subscribe to a protected event type. */
export const allowAll: Authorize<Any> = () => Effect.void;

type Target = Any | readonly Any[];

type EventsOf<T extends Target> = T extends readonly Any[]
  ? T[number]
  : Extract<T, Any>;

type TakesNoAuthorize<T extends Target> = [Protected<EventsOf<T>>] extends [
  never,
]
  ? unknown
  : "A protected event takes { authorize }: your rule, or Event.allowAll";

type NamesOf<T extends Target> = EventsOf<T>["name"];

type SourcesOf<T extends Target, R, RequestServices> = T extends Any
  ? Check<T, R> | Current<T, R> | Log<T, R>
  : {
      readonly [K in keyof RequestServices]: K extends NamesOf<T>
        ? | Check<
              Extract<EventsOf<T>, { readonly name: K }>,
              RequestServices[K]
            >
          | Current<
              Extract<EventsOf<T>, { readonly name: K }>,
              RequestServices[K]
            >
          | Log<Extract<EventsOf<T>, { readonly name: K }>, RequestServices[K]>
        : never;
    };

type Implemented<
  T extends Target,
  RequestServices,
  R,
  EX,
  RX,
  RA,
  EAX,
  RAX,
> = EventImplementation<
  EventsOf<T>,
  {
    readonly [K in NamesOf<T>]: Exclude<
      T extends readonly Any[] ? RequestServices[K & keyof RequestServices] : R,
      Scope.Scope
    >;
  },
  Deferred<EX>,
  Deferred<Exclude<RX, Scope.Scope>> | Events,
  Exclude<RA, Scope.Scope>,
  Deferred<EAX>,
  Deferred<Exclude<RAX, Scope.Scope>>
>;

/**
 * Bind sources to event types, behind authorization: one event type and its source, or a list
 * and a record of sources keyed by event name, given directly or built by an Effect whose
 * services are startup requirements, while what a source yields per subscriber is a request-time
 * requirement. `authorize` is required when the list holds a protected event type. Every surface
 * serving events takes the implementation it returns, beside action implementations in one list.
 *
 * **Gotchas**
 *
 * - The builder runs once per layer graph, however many surfaces serve it, as the first event type a surface serves attaches; a log source's `emit` starts being consumed once its event type is served or watched, and an event type no surface serves starts nothing.
 * - `check`, `current`, `match`, `transform`, `key` and `subscription` run as the subscriber: what they yield, such as the caller, is resolved per subscription.
 * - A source holds exactly one of `check`, `current` or `log`, checked as a surface serving its event type builds, which fails otherwise: a source of an event type no surface serves is not checked.
 * - Serving or watching an event type needs `Event.Events`, which its source attaches to as it builds: provide `Event.layerMemory` once, around the handlers announcing and the surfaces serving.
 * - An occurrence whose data breaks the event's payload is reported, and every surface sends a `Gap` in its place, a poll's page `truncated`: the rest of its page is still delivered.
 * - A read failing with no refusal is reported once, and the subscription reads on from where it reached: a stream a server holds, a webhook's and `Action.client`'s `watch` after 5 seconds, a client's poll, which a server answers with an error, after its reconnect backoff, from 1 second doubling to 30; a refusal ends the subscription.
 */
export function implement<
  const T extends Target,
  RequestServices extends (T extends readonly Any[]
    ? { readonly [K in NamesOf<T>]: unknown }
    : never),
  R = never,
  EX = never,
  RX = never,
  RA = never,
  EAX = never,
  RAX = never,
>(
  events: T,
  sources:
    | SourcesOf<T, R, RequestServices>
    | Effect.Effect<SourcesOf<T, R, RequestServices>, EX, RX>,
  options: [Protected<EventsOf<T>>] extends [never]
    ? | { readonly authorize?: "A public-only target takes no authorize" }
      | undefined
    : {
        // Inline, not a generic alias: through one, TypeScript 7.1 infers no `RA` from a built
        // rule declared apart, https://github.com/microsoft/TypeScript/issues/64757
        readonly authorize:
          | ((
              contract: Protected<EventsOf<T>>
            ) => Effect.Effect<void, Refusal, RA>)
          | Effect.Effect<
              (
                contract: Protected<EventsOf<T>>
              ) => Effect.Effect<void, Refusal, RA>,
              EAX,
              RAX
            >;
      }
): Implemented<T, RequestServices, R, EX, RX, RA, EAX, RAX>;
export function implement<
  const T extends Target,
  RequestServices extends (T extends readonly Any[]
    ? { readonly [K in NamesOf<T>]: unknown }
    : never),
  R = never,
  EX = never,
  RX = never,
>(
  events: T & TakesNoAuthorize<T>,
  sources:
    | SourcesOf<T, R, RequestServices>
    | Effect.Effect<SourcesOf<T, R, RequestServices>, EX, RX>
): Implemented<T, RequestServices, R, EX, RX, never, never, never>;
export function implement(
  events: Target,
  sources: ErasedValue,
  options?: { readonly authorize?: ErasedAuthorizer<Any> }
): EventImplementation<
  Any,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown
> {
  const listed = Arr.ensure(events);

  assertOnce("event", listed);

  const authorizer = authorizerOf(
    { singular: "event", module: "Event" },
    listed.some((event) => event.caller !== Anyone),
    options?.authorize
  );

  return new EventImplementation(
    listed,
    sourcesOf(listed, !Array.isArray(events), sources),
    authorizer
  );
}
