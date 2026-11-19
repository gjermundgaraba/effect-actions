import {
  Cause,
  Context,
  DateTime,
  Duration,
  Effect,
  Function,
  Layer,
  Option,
  Predicate,
  Schema,
  Stream,
} from "effect";
import type { Scope } from "effect";
import { ClusterError, Entity as Cluster } from "effect/cluster";
import type { Sharding } from "effect/cluster";
import type { Headers, HttpServerRequest } from "effect/http";
import { Rpc, RpcGroup, RpcMessage } from "effect/rpc";
import type { RpcClient } from "effect/rpc";
import { SqlClient } from "effect/sql";

import type {
  RemoteRequest,
  ServerBuildServices,
  ServedProvider,
  VerifierError,
} from "../authentication/provider.js";
import * as Action from "../contract/Action.js";
import type { Call } from "../contract/call.js";
import type { BuiltIns } from "../contract/errors.js";
import * as Event from "../contract/Event.js";
import { EventImplementation } from "../contract/feed.js";
import type {
  EventBuildServices,
  EventServedRequest,
  HoldingEvents,
  Run,
  ServingEvents,
} from "../contract/feed.js";
import { Implementation, memoized } from "../contract/implementation.js";
import type {
  ErasedAuthorize,
  ErasedValue,
  Holding,
  Member,
  Served,
  Written,
  WrittenHandler,
} from "../contract/implementation.js";
import { reported } from "../contract/reported.js";
import { buildersOf, servingOf } from "../contract/serving.js";
import type { Answer } from "../contract/stream.js";
import { Wake } from "../contract/wake.js";
import { polling } from "../contract/watch.js";
import type { WatchArgs } from "../contract/watch.js";
import { offersWebhook } from "../contract/webhooks.js";
import type { WebhookHolder } from "../contract/webhooks.js";
import type * as ActionRpc from "../rpc/ActionRpc.js";
import {
  actionMethodOf,
  erasedCallOf,
  erasedOf,
  handlersOf,
  methodsOf,
  nativeOf,
  polledTransport,
  pollOf,
  watchedOf,
  webhookCallsOf,
  webhookRpcsOf,
} from "../rpc/erased.js";
import type { InputCheck, Reach } from "../rpc/erased.js";
import { forwarded } from "./forwarded.js";
import { makeWake, wakeTag, WakeRpc } from "./wakes.js";

export { forwardedHeaders } from "./forwarded.js";

type Contract<B extends ActionRpc.Any> =
  | B["actions"][number]
  | B["events"][number];

/**
 * The key of the binding `B`'s actions and event types, the id of the entity that serves a call
 * or a subscription, read from its input: one function of every input, `({ room }) => room`.
 */
export type Key<B extends ActionRpc.Any> = (
  input: Contract<B>["input"]["Type"]
) => string;

type ErasedRpc =
  ReturnType<typeof erasedOf> extends RpcGroup.RpcGroup<infer R> ? R : never;

/**
 * A cluster `Entity` serving an `ActionRpc` binding: one rpc of JSON per action, and per event
 * type one unary rpc answering a page past a cursor, plus the entity's own native rpcs `N`, the
 * binding and the key of each of its contracts. `layer` serves it, `client` calls its actions,
 * and Effect's own `Entity` functions take it, `Entity.client` calling its native rpcs.
 */
export interface Entity<
  Type extends string,
  B extends ActionRpc.Any,
  N extends Rpc.Any = never,
> extends Cluster.Entity<Type, ErasedRpc | N> {
  readonly binding: B;
  readonly key: Key<B>;
  /**
   * The handlers of the entity's native rpcs, as `layer`'s `rpcs` takes them, typed from `make`'s
   * `rpcs`: Effect's `Entity.of`, for handlers written apart from `layer`.
   */
  readonly of: <Handlers extends Cluster.HandlersFrom<N>>(
    handlers: Handlers
  ) => Handlers;
  /** Effect's `Entity.annotate`, keeping the entity's binding and key. */
  readonly annotate: <I, S>(
    key: Context.Key<I, S>,
    value: S
  ) => Entity<Type, B, N>;
  /** Effect's `Entity.annotateMerge`, keeping the entity's binding and key. */
  readonly annotateMerge: <S>(
    annotations: Context.Context<S>
  ) => Entity<Type, B, N>;
  /**
   * Effect's `Entity.annotateRpcs`, annotating the entity's native rpcs alone and keeping its
   * binding and key.
   *
   * **Gotchas**
   *
   * - The rpcs of the binding's actions, event types and webhook subscriptions keep their own annotations, volatile: `ClusterSchema.Persisted` here persists the natives, never a caller's credential-bearing envelope.
   */
  readonly annotateRpcs: <I, S>(
    key: Context.Key<I, S>,
    value: S
  ) => Entity<Type, B, N>;
  /**
   * Effect's `Entity.annotateRpcsMerge`, annotating the entity's native rpcs alone, as
   * `annotateRpcs` does, and keeping its binding and key.
   */
  readonly annotateRpcsMerge: <S>(
    annotations: Context.Context<S>
  ) => Entity<Type, B, N>;
}

/**
 * Any entity `make` returns, as a function accepting every entity reads it: its type, its
 * binding, and its `client`, Effect's `Entity.client`, whose client's methods are keyed by rpc tag.
 */
export interface Any {
  readonly type: string;
  readonly binding: ActionRpc.Any;
  readonly client: Effect.Effect<
    (entityId: string) => object,
    never,
    Sharding.Sharding
  >;
}

const namedBy =
  (key: (input: Action.Any["input"]["Type"]) => string) =>
  (input: Action.Any["input"]["Type"]): string | undefined => {
    const named: unknown = key(input);

    return Predicate.isString(named) ? named : undefined;
  };

type WithoutNatives<B extends ActionRpc.Any> = [
  RpcGroup.Rpcs<B["rpcs"]>,
] extends [never]
  ? unknown
  : {
      readonly "An entity's binding holds no native rpcs: give them to ActionEntity.make's rpcs": never;
    };

const libraryRpcsOf = (binding: ActionRpc.Any) =>
  erasedOf(binding.actions, binding.events, "ActionEntity.layer")
    .merge(webhookRpcsOf(binding.events))
    .add(WakeRpc);

const entityOf = <
  Type extends string,
  B extends ActionRpc.Any,
  N extends Rpc.Any,
>(
  type: Type,
  binding: B,
  key: Key<B>,
  library: ReturnType<typeof libraryRpcsOf>,
  natives: RpcGroup.RpcGroup<Rpc.AnyWithProps>
): Entity<Type, B, N> => {
  const rebuilt = (annotated: typeof natives) =>
    entityOf<Type, B, N>(type, binding, key, library, annotated);

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const protocol = library.merge(natives) as RpcGroup.RpcGroup<ErasedRpc | N>;

  return Object.assign(Cluster.fromRpcGroup(type, protocol), {
    binding,
    key,
    of: <Handlers extends Cluster.HandlersFrom<N>>(handlers: Handlers) =>
      handlers,
    annotate: <I, S>(tag: Context.Key<I, S>, value: S) =>
      rebuilt(natives.annotate(tag, value)),
    annotateMerge: <S>(annotations: Context.Context<S>) =>
      rebuilt(natives.annotateMerge(annotations)),
    annotateRpcs: <I, S>(tag: Context.Key<I, S>, value: S) =>
      rebuilt(natives.annotateRpcs(tag, value)),
    annotateRpcsMerge: <S>(annotations: Context.Context<S>) =>
      rebuilt(natives.annotateRpcsMerge(annotations)),
  });
};

/** `make`'s options. */
export interface MakeOptions<B extends ActionRpc.Any, N extends Rpc.Any> {
  /**
   * The entity id an input names: one function every action and event input of the binding
   * reads, `({ room }) => room`.
   *
   * **Gotchas**
   *
   * - It takes the union of the binding's inputs, so it reads only a field every one declares: a field one input lacks is a type error.
   */
  readonly key: Key<B>;
  /**
   * The entity's own native rpcs, beside its actions and event types, with their own schemas:
   * `RpcGroup.make(Expire)`, such as a tell another entity sends it; an entity waking itself later
   * calls `wakeAt` instead. `layer` takes their handlers in its own `rpcs`.
   *
   * **Gotchas**
   *
   * - A native rpc authenticates nothing, whatever the binding's `authentication`: it is for tells the entity and other entities send with `Entity.client`, never for a surface's callers.
   * - A native rpc named after an action, an event type, an event's `<event>/poll`, a protected event's `<event>/subscribe` or `<event>/unsubscribe`, or the entity's wake, `effect-actions/wake`, throws as the entity is made.
   */
  readonly rpcs?: RpcGroup.RpcGroup<N> | undefined;
}

/**
 * The cluster entity of type `type` serving the actions and event types of `binding`, an
 * `ActionRpc` binding, each call and subscription in the entity its contract's `key` names for
 * its input. Each event type is a unary rpc named `<event>/poll`, `ActionRpc.pollTag`, taking
 * `{ input, cursor, maxEvents, watch }` and answering a page,
 * `{ events, cursor, truncated, hasMore, nextPollMs, notified }`, an HTTP poll's page and
 * `notified`, `ActionRpc.Page`, as `ActionRpc.layer` serves it too, its subscription hook held
 * for the caller's principal. A protected event type has two more, `<event>/subscribe` and
 * `<event>/unsubscribe`, taking a webhook subscription and its cancellation, and the entity has
 * its wake, `effect-actions/wake`, the persisted tell `wakeAt` sends it, which a webhook
 * delivery's retry wait shares. Guide: `docs/ActionEntity.md` in this package.
 *
 * **Gotchas**
 *
 * - The rpcs of its actions, event types and webhook subscriptions are volatile, as `ClusterSchema.Persisted` defaults, and its wake alone is persisted: annotated persisted, each envelope, its caller's headers and credential included, would be stored and replayed with them, on Effect's SQL runners until a `MessageRetention` layer deletes it, and on the Cloudflare runtime, which never prunes `cluster_messages`, for good, its credential headers redacted. `rpcs`' natives are persisted as their own annotations say.
 * - A binding with native rpcs throws: give the entity's own rpcs to `make`'s `rpcs`.
 * - A streaming action, one declaring `progress` or answering `Action.Stream`, is a stream rpc, its frames those `ActionRpc.make` states, `client`'s method handing each progress value to `onProgress` before it answers, and returning a `Stream` of the elements of an `Action.Stream` answer; it holds a slot of the entity's `concurrency`, by default its only one, until its stream ends, but on the Cloudflare runtime, which frees the slot while a frame waits for its client's acknowledgement.
 */
export const make = <
  const Type extends string,
  const B extends ActionRpc.Any,
  N extends Rpc.Any = never,
>(
  type: Type,
  binding: B & WithoutNatives<B>,
  options: NoInfer<Omit<MakeOptions<B, N>, "rpcs">> &
    Pick<MakeOptions<B, N>, "rpcs">
): Entity<Type, B, N> => {
  const natives = [...nativeOf(binding.rpcs).requests.keys()];

  if (natives.length > 0) {
    throw new Error(
      `ActionEntity.make: the binding of ${type} holds native rpcs, ${natives.join(", ")} (give them to ActionEntity.make's rpcs, unauthenticated)`
    );
  }

  const erased = libraryRpcsOf(binding);

  const rpcs = options.rpcs ?? RpcGroup.make();

  const taken = [...rpcs.requests.keys()].filter(
    (tag) =>
      erased.requests.has(tag) ||
      binding.events.some(({ name }) => name === tag)
  );

  if (taken.length > 0) {
    throw new Error(
      `ActionEntity.make: the native rpcs of ${type}, ${taken.join(", ")}, are named after an action, an event type, an event's poll, subscribe or unsubscribe, or the entity's wake, ${wakeTag} (rename them)`
    );
  }

  return entityOf<Type, B, N>(
    type,
    binding,
    options.key,
    erased,
    nativeOf(rpcs)
  );
};

/**
 * The rpcs of `entity`'s binding, as its `protocol` holds them without its native rpcs: one per
 * action, and per event type its poll. What a surface outside the
 * cluster may forward to the entity, as the Cloudflare package's socket host does, which
 * `ActionRpc.client`'s watch polls, finding no stream rpc.
 */
export const bindingRpcs = (entity: Any): RpcGroup.RpcGroup<ErasedRpc> =>
  erasedOf(entity.binding.actions, entity.binding.events, "ActionEntity.layer");

/**
 * `layer`'s options: `Entity.toLayer`'s, which the entity's registration takes, but
 * `disableFatalDefects`, which is always on, and `defectRetryPolicy`, which the Cloudflare
 * runtime would follow to run a call that died again, and `services` and `rpcs`.
 */
export interface LayerOptions<
  ROut = never,
  RIn = never,
  Handlers = never,
  RX = never,
  RW = never,
> extends Omit<
  NonNullable<Parameters<Cluster.Any["toLayer"]>[1]>,
  "disableFatalDefects" | "defectRetryPolicy"
> {
  /**
   * What each entity id builds for itself as it activates, before its implementations'
   * builders and its native rpcs' handlers, which read it, as its handlers do per call: a store
   * over the entity's own database, its `Event.Events`. It may read `Entity.CurrentAddress` and what the activation
   * provides, such as a Durable Object's `DurableObjectSqlClient`.
   *
   * **Gotchas**
   *
   * - Each entity id builds it again at each activation: what it holds in memory is that activation's alone, as an implementation builder's is, where a service provided to `layer` is the runner's, shared by every entity id.
   * - It fails or dies as a builder does: a defect of the activation, which the runtime handles as the builder's.
   * - A handler reading its output per call, where it is written inline as a `Layer.merge` or another generic combinator's result, is a type error naming that output, which TypeScript infers too late: assign the layer to a `const` first.
   * - A `Webhook.layer` here holds the entity's webhook subscriptions and delivers them from its activation: give it `persist`, so a later activation restores them; each retry wait is a wake the entity sends itself, so a stopped entity is built again to retry, on Effect's SQL runners up to `entityMessagePollInterval` after it is due, each wake a row of the runtime's messages, kept once processed.
   * - A webhook subscription to a check source not `notified` is refused with `Event.SubscriptionError`, reason `Unsupported`, and a warning saying why, its polls and unsubscribes still served: its reads on a timer would be cut by Effect's reaper and keep a Durable Object awake.
   * - A webhook subscription past its expiry ends at its next delivery, and its kept record at the next activation, on no timer: until then it holds its subscription hook.
   * - A `Webhook.layer` here with `persist` needs the binding's authentication to name a `schema` where it serves a protected event whose source is no check source left un-`notified`: without one each activation dies with the library's message naming `schema`, so on Effect's runners each call to the entity waits while the runner builds it again, and on the Cloudflare runtime each fails at once.
   */
  readonly services?: Layer.Layer<ROut, unknown, RIn> | undefined;
  /**
   * The handlers of `make`'s `rpcs`, as `Entity.toLayer` takes them: an `Entity.HandlersFrom` of
   * those rpcs, or an Effect building one as each entity id activates, after `services`, whose
   * output it and the handlers' answers read, either typed from those rpcs where written here, or
   * by the entity's `of` where written apart. Each handler receives Effect's own `Entity.Request`,
   * its `payload`, `headers` and `requestId`, and may answer through `Rpc.fork` or
   * `Rpc.uninterruptible`.
   *
   * **Gotchas**
   *
   * - Required exactly where `make` was given `rpcs`: left out there, or given for an entity without them, it is a type error.
   */
  readonly rpcs?:
    | ([Handlers] extends [never]
        ? never
        : Handlers | Effect.Effect<Handlers, never, RX>)
    | undefined;
  /**
   * What the entity does when its wake fires, given the time it was due: `wakeAt` schedules it,
   * and it runs in whichever activation is current then, one built again for it where the entity
   * had stopped, reading `services`' output as a handler does.
   *
   * **Gotchas**
   *
   * - It is a check, not one reminder per `wakeAt`: it runs at the earliest time asked for, early for the later ones, which it asks for again, and may run again for a wake already handled, as a replay after a restart: do what is due by then and `wakeAt` the next time.
   * - The entity's webhook retry waits share its wake, so with a `Webhook.layer` in `services` it also runs when a delivery's retry is due.
   * - It runs beside the entity's calls, outside its `concurrency`, as a webhook delivery holding the entity's only slot waits on the wake, and two deliveries, such as a replay and a fresh wake, run it at once: a read, change and write of state it shares with a handler or with itself needs its own lock or transaction.
   * - Its failure or defect is reported to the `ErrorReporter`s the activation provides and logged, and that wake is done; interrupted as the entity stops, it runs again in the next activation.
   * - On the Cloudflare runtime, a call's defect that rebuilds the activation in place while it runs closes the services it reads beneath it, and that wake counts as handled, as `@effect/platform-cloudflare` 4.1.4 finalizes an activation without waiting for its tells: keep it a check the next `wakeAt` repeats, not the only record of work.
   */
  readonly onWake?:
    | ((at: DateTime.Utc) => Effect.Effect<void, unknown, RW>)
    | undefined;
}

type NativeLayerOptions<N extends Rpc.Any, ROut, RIn, Handlers, RX, RW> = [
  N,
] extends [never]
  ? [options?: LayerOptions<ROut, RIn, never, never, RW>]
  : [
      options: LayerOptions<ROut, RIn, Handlers, RX, RW> & {
        readonly rpcs: Handlers | Effect.Effect<Handlers, never, RX>;
      },
    ];

/**
 * What an entity's activation provides to `layer`'s `services`, its implementations' builders and
 * the Effect building its native rpcs' handlers, without requiring it of the layer: the entity's
 * `Entity.CurrentAddress`, its runner's `Entity.CurrentRunnerAddress`, the activation's
 * `Scope`, closed as the entity stops, and the entity's wake, which `wakeAt` reads, as its
 * handlers and `onWake` do too. A layer an application builds for `services` apart from `layer`
 * reads it as `Layer.Layer<ROut, E, ActionEntity.Activation | …>`.
 *
 * **Gotchas**
 *
 * - A handler's `Scope`, a native one's or an action's, is its call's, closed as the call ends: acquire what lives as long as the activation in `services` or a builder.
 */
export type Activation =
  | Cluster.CurrentAddress
  | Cluster.CurrentRunnerAddress
  | Scope.Scope
  | Wake;

/**
 * Wake the entity at `at`: a persisted tell it sends itself, delivered then to `layer`'s
 * `onWake`, through eviction, a restart and a deploy, in whichever activation is current, built
 * again for it where the entity had stopped. It succeeds once the runtime stored the tell, and
 * fails with `Action.Unavailable` where it could not, so a caller knows the wake is scheduled
 * before it starts what the wake guards. Read it in the entity: `services`, a builder or a handler.
 *
 * **Gotchas**
 *
 * - The wake keeps the earliest time: a time no earlier than one this activation scheduled and has not seen fire sends nothing, as that wake's `onWake` asks for it again; a tell cannot be taken back, so a time moved later or dropped still fires.
 * - Each wake is a row of the runtime's messages, kept once processed, on Effect's SQL runners until a `MessageRetention` layer deletes it, and on the Cloudflare runtime for good.
 * - It holds nothing awake: work already running keeps its activation with `Entity.keepAlive` and its Durable Object event with `waitUntil`, beside the wake that resumes it later.
 * - Asked for inside a transaction of the entity's or the runner's `SqlClient`, it dies, as the wake would be stored in that transaction and dropped by its rollback while the activation counted it pending: call it after the transaction commits.
 * - A time between milliseconds is rounded up to the next one, as the runtime stores whole milliseconds.
 */
export const wakeAt = (
  at: DateTime.DateTime
): Effect.Effect<void, Action.Unavailable, Wake> =>
  Effect.flatMap(Wake, (wake) =>
    wake.wakeAt(Math.ceil(DateTime.toEpochMillis(at)))
  );

type PerCall<
  B extends ActionRpc.Any,
  Apps extends Served,
  ROut,
  A extends Action.Any = B["actions"][number],
  E extends Event.Any = B["events"][number],
> = Exclude<
  RemoteRequest<Member<Apps>, A> | EventServedRequest<Member<Apps>, E>,
  | Activation
  | HttpServerRequest.HttpServerRequest
  | HttpServerRequest.ParsedSearchParams
  | ROut
>;

type NoPerCall<B extends ActionRpc.Any, Apps extends Served, ROut> = [
  PerCall<B, Apps, ROut>,
] extends [never]
  ? unknown
  : {
      readonly "An entity provides no service per call but services' output: yield it in the implementation's builder, where it is a startup service, or build it in layer's services": PerCall<
        B,
        Apps,
        ROut
      >;
    };

type EntityLayer<
  B extends ActionRpc.Any,
  Apps extends Served,
  N extends Rpc.Any,
  ROut,
  RIn,
  Handlers,
  RX,
  RW,
  A extends Action.Any = B["actions"][number],
  E extends Event.Any = B["events"][number],
> = Layer.Layer<
  never,
  never,
  | Exclude<
      | ServerBuildServices<Holding<Member<Apps>, A>, A>
      | EventBuildServices<HoldingEvents<Member<Apps>, E>, E>
      | ServedProvider<
          Member<Apps>,
          A,
          B extends { readonly authentication: infer D } ? D : never,
          ServingEvents<Member<Apps>, E>
        >
      | RX
      | RW
      | RpcGroup.HandlersServices<N, Handlers>,
      Activation | ROut
    >
  | Exclude<RIn, Activation>
  | Rpc.ServicesClient<N>
  | Rpc.ServicesServer<N>
  | Rpc.Middleware<N>
  | Sharding.Sharding
>;

const callOf = (request: Cluster.Request<Rpc.Any>, rpc: Rpc.AnyWithProps) => ({
  client: new Rpc.ServerClient(0),
  requestId: RpcMessage.RequestId(String(request.requestId)),
  headers: request.headers,
  rpc,
});

type NativeHandler = (
  request: Cluster.Request<Rpc.Any>
) => Rpc.WrapperOr<
  | Effect.Effect<unknown, unknown, unknown>
  | Stream.Stream<unknown, unknown, unknown>
>;

const ClusterFailures = Schema.Union([
  ClusterError.MailboxFull,
  ClusterError.PersistenceError,
  ClusterError.AlreadyProcessingMessage,
  ClusterError.EntityNotAssignedToRunner,
]);

/**
 * Whether a failure is one of those Effect's entity client fails with when the entity could not
 * be reached, `MailboxFull`, `PersistenceError`, `AlreadyProcessingMessage` and
 * `EntityNotAssignedToRunner`, which `client`, `nativeClient` and `reaching` answer as
 * `Action.Unavailable`: a server forwarding calls into an entity, as the Cloudflare package's
 * socket host does, makes them a defect, and a Worker calling Effect's `Entity.client` itself
 * answers them, as the Cloudflare package's `ActionCluster.failureResponse` does, with a 503.
 */
export const isClusterFailure = Schema.is(ClusterFailures);

/**
 * Register `entity` with the cluster's `Sharding`, serving its binding's actions and event types
 * from `implementations`, which implement every one. Each entity id builds the implementations
 * itself as it activates, so a builder may read `Entity.CurrentAddress`; each call of a
 * protected one authenticates from the headers its client sent with the binding's descriptor, as
 * `ActionRpc.layer`'s does; then the input decodes, failing `InvalidInput` where it does not, an
 * input whose key names another entity or none is refused with `Forbidden`, and the
 * implementation's `authorize` and the handler run; a declared error is the call's typed failure.
 *
 * **Gotchas**
 *
 * - What the application provides to this layer is shared by every entity of the runner; what an implementation builds, each entity id builds for itself: state held in a builder is that entity's alone.
 * - A handler, an authorizer or an event source reading per call a service other than its caller and `services`' output is a type error naming that service: an entity provides nothing else per call, so yield it in the builder, where it is a startup service, one value for every caller and entity id, or build it in `services`, one per entity id.
 * - `services`' output lies under each call's own context, so a service it outputs that a call provides too, its caller or its request, is the call's.
 * - `Action.layer` above it shares no build with it: each entity id runs its implementations' builders again, beside the run `Action.layer` made for the other surfaces.
 * - A builder that fails or dies is a defect of the entity's activation, never a failure of the layer: Effect's own runners log it and build again, 500 ms later and growing to 10 seconds apart, while its calls wait, and the Cloudflare runtime fails the calls waiting on that build, the next call building again.
 * - A handler's defect or undeclared failure ends that call with an `Error` whose message is `Internal server error`, as on `ActionRpc.layer`, and the call is not run again; Effect's own runners keep the entity's handlers for its next call, and the Cloudflare runtime builds them again, so what its builders and `services` held in memory is gone.
 * - An implementation missing for one of the binding's actions or event types throws as the layer is made: an entity serves its whole binding.
 */
export function layer<
  const Type extends string,
  const B extends ActionRpc.Any,
  N extends Rpc.Any,
  const Apps extends Served,
  Handlers extends Cluster.HandlersFrom<N>,
  ROut = never,
  RIn = never,
  RX = never,
  RW = never,
>(
  entity: Entity<Type, B, N>,
  implementations: Apps & NoPerCall<B, Apps, ROut>,
  ...options: NativeLayerOptions<N, ROut, RIn, Handlers, RX, RW>
): EntityLayer<B, Apps, N, ROut, RIn, Handlers, RX, RW>;
export function layer<Type extends string, B extends ActionRpc.Any>(
  entity: Entity<Type, B, Rpc.Any>,
  served: Served,
  {
    services = Layer.empty,
    rpcs = {},
    onWake,
    ...options
  }: LayerOptions<
    never,
    unknown,
    Readonly<Record<string, NativeHandler>>,
    unknown,
    unknown
  > = {}
): Layer.Layer<never, never, unknown> {
  const { binding } = entity;
  const named = namedBy(entity.key);

  const { apps, events, authentication } = servingOf(
    "ActionEntity binding",
    binding,
    served,
    { actions: [...binding.actions, ...binding.events] }
  );

  const [first, ...rest] = buildersOf(apps, events);

  const build = Effect.gen(function* () {
    const address = yield* Cluster.CurrentAddress;

    const sharding = yield* Effect.context<Sharding.Sharding>();

    const outsideTransactions = Effect.gen(function* () {
      const clients = [
        yield* Effect.serviceOption(SqlClient.SqlClient),
        Context.getOption(sharding, SqlClient.SqlClient),
      ].flatMap(Option.toArray);

      for (const sql of clients) {
        if (
          Option.isSome(yield* Effect.serviceOption(sql.transactionService))
        ) {
          return yield* Effect.die(
            new Error(
              `ActionEntity.wakeAt: the wake of ${address.entityType}/${address.entityId} was asked for inside a SQL transaction, whose rollback would drop it unseen (call wakeAt after the transaction commits)`
            )
          );
        }
      }
    });

    const { wake, woke } = yield* makeWake((payload) =>
      Effect.andThen(
        outsideTransactions,
        Effect.flatMap(entity.client, (clientFor) => {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const self = clientFor(address.entityId) as RpcClient.RpcClient<
            typeof WakeRpc,
            typeof ClusterFailures.Type
          >;

          return self[wakeTag](payload, { discard: true });
        }).pipe(
          Effect.catchIf(isClusterFailure, ({ _tag }) =>
            Effect.fail(
              new Action.Unavailable({
                message: `The wake of ${address.entityType}/${address.entityId} could not be scheduled (${_tag})`,
              })
            )
          ),
          Effect.provideContext(sharding)
        )
      )
    );

    const built = yield* Layer.buildWithMemoMap(
      Layer.provideMerge(
        first === undefined
          ? services
          : Layer.provideMerge(Layer.mergeAll(first, ...rest), services),
        Layer.succeed(Wake, wake)
      ),
      Layer.makeMemoMapUnsafe(),
      yield* Effect.scope
    );

    const check: InputCheck = (contract, input) => {
      const entityId = named(input);

      return entityId === address.entityId
        ? Effect.void
        : Effect.fail(
            new Action.Forbidden({
              message: `This entity is ${address.entityType}/${address.entityId}, and the input of ${contract.name} names ${entityId ?? "none"}`,
            })
          );
    };

    const { handlers } = yield* Effect.provideContext(
      handlersOf(binding, {
        apps,
        events,
        authentication,
        server: { _tag: "ActionEntity.layer", check },
      }),
      built
    );

    const natives = yield* Effect.provideContext(
      Effect.isEffect(rpcs) ? rpcs : Effect.succeed(rpcs),
      built
    );

    const woken = (at: number) =>
      onWake === undefined
        ? Effect.void
        : Effect.provideContext(
            Effect.catchCauseIf(
              onWake(DateTime.makeUnsafe(at)),
              (cause) => !Cause.hasInterruptsOnly(cause),
              reported
            ),
            built
          );

    const answering =
      (handler: NativeHandler): NativeHandler =>
      (request) =>
        Rpc.wrapMap(handler(request), (answer) =>
          Effect.isEffect(answer)
            ? Effect.provideContext(answer, built)
            : Stream.provideContext(answer, built)
        );

    return Object.fromEntries(
      [...nativeOf(entity.protocol).requests.values()].map((rpc) => {
        if (rpc._tag === wakeTag) {
          return [
            rpc._tag,
            ({ payload }: Cluster.Request<typeof WakeRpc>) =>
              Rpc.fork(
                Effect.andThen(woke(payload.at), () => woken(payload.at))
              ),
          ] as const;
        }

        const handler = handlers[rpc._tag];

        if (handler !== undefined) {
          return [
            rpc._tag,
            (request: Cluster.Request<ErasedRpc>) => {
              const answer: Effect.Effect<unknown, unknown, unknown> = handler(
                request.payload,
                callOf(request, rpc)
              );

              return Effect.provideContext(answer, built);
            },
          ] as const;
        }

        const native = natives[rpc._tag];

        if (native === undefined) {
          throw new Error(
            `ActionEntity.layer: rpcs holds no handler for the native rpc ${rpc._tag} of ${entity.type} (give layer's rpcs a handler for each of make's rpcs)`
          );
        }

        return [rpc._tag, answering(native)] as const;
      })
    );
  }).pipe(Effect.orDie);

  return entity.toLayer(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    build as Effect.Effect<Cluster.HandlersFrom<ErasedRpc>>,
    { ...options, disableFatalDefects: true }
  );
}

/**
 * What one call of an action `A` fails with, beside the binding's errors `E`: its declared and
 * built-in errors, `Action.Unavailable` among them where the entity could not be reached or did
 * not answer in time. An answer that does not decode is a defect.
 */
export type MethodError<
  A extends Action.Any,
  E extends Action.Errors[number] = never,
> = A["error"][number]["Type"] | E["Type"] | BuiltIns["Type"];

type Method<A extends Action.Any, E extends Action.Errors[number]> = Call<
  A,
  Answer<A["success"], MethodError<A, E>, never>
>;

/**
 * What a watch of `W` over the binding `B` may fail with: a refusal, `InvalidInput`, the
 * binding's errors or an `Event.SubscriptionError` (`NotServed` for an event the entity does not
 * serve).
 */
export type WatchError<W extends Event.Any, B extends ActionRpc.Any> =
  | Event.SubscriptionError
  | BuiltIns["Type"]
  | B["error"][number]["Type"]
  | VerifierError<W, B["authentication"]>["Type"];

type Watching<B extends ActionRpc.Any> = [B["events"][number]] extends [never]
  ? unknown
  : {
      readonly watch: <W extends B["events"][number], SE = never>(
        event: W,
        ...args: WatchArgs<W, SE, { readonly mode?: "poll" | undefined }>
      ) => Stream.Stream<Event.Received<W>, WatchError<W, B> | SE>;
    };

/**
 * Every action of the binding `B`, as `client.<action>(input)`: a protected one may also fail
 * with what its descriptor's verifier declares. Where `B` lists event types, `watch(event, input,
 * options)` follows one by polling.
 */
export type Client<B extends ActionRpc.Any> = {
  readonly [A in B["actions"][number] as A["name"]]: Method<
    A,
    B["error"][number] | VerifierError<A, B["authentication"]>
  >;
} & Watching<B>;

/** `client`'s, `nativeClient`'s and `reaching`'s options. */
export interface EntityCallOptions {
  /**
   * How long one call to the entity waits for its answer before failing with
   * `Action.Unavailable`: an action's call, a native rpc's, a poll, and a webhook subscribe or
   * unsubscribe. 20 seconds by default.
   *
   * **Gotchas**
   *
   * - It bounds the wait for the entity's answer alone, as the `Unavailable` it fails with says the entity did not answer: encoding the input and decoding the answer, in the caller's process, run outside it.
   * - It bounds each call and each poll alone: a stream following an event, HTTP's `text/event-stream`, an RPC subscription or a watch, outlives it, each of its polls bounded by it.
   * - A streaming rpc, a streaming action's, one declaring `progress` or answering `Action.Stream`, or a native one's, its `asQueue` call's included, has no deadline, as it may answer for longer: bound it with the host's request timeout.
   * - The call is interrupted at the deadline, and the entity may have run part of it or all of it: the answer is `Unavailable`, the outcome unknown.
   */
  readonly timeout?: Duration.Input | undefined;
}

const defaultTimeout = Duration.seconds(20);

type EntityRpcs = ReturnType<
  Effect.Success<Cluster.Entity<string, ErasedRpc>["client"]>
>;

type CallOptions = Parameters<EntityRpcs[string]>[1];

interface QueueOptions {
  readonly asQueue?: boolean | undefined;
  readonly streamBufferSize?: number | undefined;
}

const sendingWithin = (type: string, options: EntityCallOptions) => {
  const timeout = Duration.fromInputUnsafe(options.timeout ?? defaultTimeout);

  return (entityId: string, rpcs: EntityRpcs) => {
    const unavailable = (tag: string, outcome: string) =>
      new Action.Unavailable({
        message: `${tag}: the entity ${type}/${entityId} ${outcome}; the call's outcome is unknown, as the entity may still run it`,
      });

    const unreached =
      (tag: string) =>
      ({ _tag }: typeof ClusterFailures.Type) =>
        unavailable(tag, `could not be reached (${_tag})`);

    return (tag: string, payload: unknown, callOptions?: CallOptions) => {
      const method = rpcs[tag];

      if (method === undefined) {
        return Effect.die(new Error(`ActionEntity: no rpc ${tag}`));
      }

      const answer:
        | Effect.Effect<Schema.Json, unknown>
        | Stream.Stream<Schema.Json, unknown> = method(payload, {
        ...callOptions,
        asQueue: false,
      });

      return Effect.isEffect(answer)
        ? Effect.catchIf(answer, isClusterFailure, (failure) =>
            Effect.fail(unreached(tag)(failure))
          ).pipe(
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () =>
                Effect.fail(
                  unavailable(
                    tag,
                    `did not answer within ${Duration.format(timeout)}`
                  )
                ),
            })
          )
        : Stream.catchIf(answer, isClusterFailure, (failure) =>
            Stream.fail(unreached(tag)(failure))
          );
    };
  };
};

const reachOf =
  <Type extends string, B extends ActionRpc.Any, N extends Rpc.Any>(
    entity: Entity<Type, B, N>,
    headers: Effect.Effect<Headers.Headers | undefined>,
    options: EntityCallOptions
  ) =>
  (
    clientFor: Effect.Success<Cluster.Entity<string, ErasedRpc>["client"]>
  ): Reach => {
    const named = namedBy(entity.key);
    const sending = sendingWithin(entity.type, options);

    return (contract, input) => {
      const entityId = named(input);

      return entityId === undefined
        ? Effect.fail(
            new Action.Forbidden({
              message: `The input of ${contract.name} names no entity of ${entity.type}`,
            })
          )
        : Effect.map(headers, (sent) => {
            const send = sending(entityId, clientFor(entityId));

            return erasedCallOf((tag, payload) =>
              send(
                tag,
                payload,
                sent === undefined ? undefined : { headers: sent }
              )
            );
          });
    };
  };

/**
 * The client of `entity` over Effect's own `Entity.client`: one method per action taking its
 * input, `rooms.postMessage({ room: "lobby", text })`, and `watch(event, input, options)`, which
 * polls the event's rpc, each call and watch sent to the entity its input's key names. A call
 * the entity could not be reached for, or that did not answer within `options.timeout`, 20
 * seconds by default, fails with the built-in `Action.Unavailable`, as through `reaching`.
 * Requires `Sharding`, as `Entity.client` does: `TestRunner.layer` in a test. The entity's native
 * rpcs are `nativeClient`'s methods.
 *
 * **Gotchas**
 *
 * - An input whose key names no entity, such as one missing the key's field, fails with `Forbidden`, sending nothing.
 * - Headers set with `RpcClient.withHeaders` around a call go with its envelope, which is how a protected call sends its credential; a call without them fails `Unauthenticated`.
 * - What `Entity.client` fails with, `MailboxFull`, `AlreadyProcessingMessage`, `PersistenceError` or `EntityNotAssignedToRunner`, is the call's `Action.Unavailable`, its message naming that failure and saying the outcome is unknown, as the entity may still run the call.
 * - A watch polls, its only `mode` `"poll"`, at the page's `nextPollMs`, each poll bounded by `timeout`, its polls holding the subscription hook of the caller's principal in the entity until its source's `lease` lapses after the last, whichever watch sent it.
 * - A watch asks the entity again after `Action.Unavailable`, from where it reached, a second later and doubling to 30 seconds; another declared error, a refusal included, ends it.
 */
export const client = <
  const Type extends string,
  const B extends ActionRpc.Any,
  N extends Rpc.Any = never,
>(
  entity: Entity<Type, B, N>,
  options: EntityCallOptions = {}
): Effect.Effect<Client<B>, never, Sharding.Sharding> => {
  const methods = methodsOf(
    entity.binding,
    polledTransport(Function.constFalse)
  );

  const reach = reachOf(entity, Effect.undefined, options);

  return Effect.map(
    entity.client,
    (clientFor) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      methods(reach(clientFor)) as Client<B>
  );
};

/**
 * Effect's own client of an entity's native rpcs `N`, `make`'s `rpcs`, its methods keyed by rpc
 * tag, each failing with its rpc's errors and `Action.Unavailable` in place of what Effect's
 * entity client fails with.
 */
export type NativeClient<N extends Rpc.Any> = RpcClient.RpcClient.From<
  N,
  Action.Unavailable
>;

/**
 * The client of `entity`'s native rpcs, `make`'s `rpcs`, over Effect's own `Entity.client`, for
 * the entity id it is given: `(yield* ActionEntity.nativeClient(Room))("lobby").expire()`. Each
 * call answers as `client`'s do: one the entity could not be reached for, or that did not answer
 * within `options.timeout`, 20 seconds by default, fails with `Action.Unavailable`. Requires
 * `Sharding`, as `Entity.client` does.
 *
 * **Gotchas**
 *
 * - A tell, a call with `discard: true`, is bounded too: it fails with `Unavailable` where the entity's mailbox did not take it within `timeout`.
 * - A stream rpc's call has no deadline, and a cluster failure ends its stream with `Unavailable`; a call with `asQueue: true` makes its queue from that stream, buffering `streamBufferSize` elements, 16 by default, so a take fails with `Unavailable` too.
 * - Effect's own `entity.client` still fails with the cluster's errors, and waits without end on an entity no runner is assigned: call it only where that is wanted.
 */
export function nativeClient<
  const Type extends string,
  const B extends ActionRpc.Any,
  N extends Rpc.Any,
>(
  entity: Entity<Type, B, N>,
  options?: EntityCallOptions
): Effect.Effect<
  (entityId: string) => NativeClient<N>,
  never,
  Sharding.Sharding
>;
export function nativeClient(
  entity: Entity<string, ActionRpc.Any, Rpc.AnyWithProps>,
  options: EntityCallOptions = {}
): Effect.Effect<(entityId: string) => object, never, Sharding.Sharding> {
  const sending = sendingWithin(entity.type, options);
  const library = libraryRpcsOf(entity.binding).requests;

  const tags = [...entity.protocol.requests.keys()].filter(
    (tag) => !library.has(tag)
  );

  return Effect.map(entity.client, (clientFor) => (entityId) => {
    const send = sending(entityId, clientFor(entityId));

    return Object.fromEntries(
      tags.map((tag) => [
        tag,
        (payload: unknown, callOptions?: CallOptions & QueueOptions) => {
          const answer = send(tag, payload, callOptions);

          return Stream.isStream(answer) && callOptions?.asQueue === true
            ? Stream.toQueue(answer, {
                capacity: callOptions.streamBufferSize ?? 16,
              })
            : answer;
        },
      ])
    );
  });
}

type Nothing<C extends Action.Any | Event.Any> = {
  readonly [K in C["name"]]: never;
};

/**
 * The implementations of `entity`'s actions and event types that any surface serves beside its
 * own, `ActionHttp.layer`, `ActionRpc.layer` or `ActionMcp.layerHttp`: each call sent through
 * `Entity.client` to the entity its contract's key names for its input, with the caller's
 * headers, and its answer, declared errors and progress passed back; each event followed through
 * the entity's poll rpc. A call the entity could not be reached for, or that did not answer
 * within `timeout`, fails with the built-in `Action.Unavailable`, whose message says the entity
 * may still run it.
 *
 * **Gotchas**
 *
 * - The caller's credential is verified by the surface serving these and again by the entity reached, so both are given the verifier: a call the surface refuses reaches no entity.
 * - A refusal by the entity, a credential expired since the surface verified it included, ends a stream after it answered 200, where the surface's own refusal would have answered its 401 or 403.
 * - The caller's request's headers are sent on as `forwardedHeaders` keeps them: its connection's, its body's, what it accepts and an MCP request's routing headers are not.
 * - A credential in the query, an API key the serving surface's HTTP binding reads `in: "query"`, never reaches the entity, whose binding reads headers alone, so it refuses the call with `Unauthenticated`: read the key from a header on the HTTP binding too.
 * - A call with no HTTP request, as through `Action.client` in process or an MCP stdio surface, sends only the headers `RpcClient.withHeaders` sets around it: without them the entity refuses a protected one with `Unauthenticated`.
 * - What `Entity.client` fails with, `MailboxFull`, `AlreadyProcessingMessage`, `PersistenceError` or `EntityNotAssignedToRunner`, is the call's `Action.Unavailable`, its message naming that failure: a 503 with `Retry-After: 1` over HTTP, an `isError: true` tool result over MCP, the typed failure over RPC.
 * - A call to an entity no runner is assigned, which Effect's entity client retries every `sendRetryInterval`, 100 milliseconds by default, without limit, answers `Action.Unavailable` at `timeout`.
 * - A stream, HTTP's `text/event-stream`, an RPC subscription or MCP's `events/stream`, polls the entity from the surface, at once while a page has more and otherwise at its `nextPollMs`, a second at least: it holds the caller's request open but no entity, an occurrence arrives up to that interval late, and the entity's object takes a call each `nextPollMs` while the stream is open, so on Cloudflare a stream polling every few seconds keeps it from ever hibernating.
 * - A stream asks the entity again after a poll failed with `Action.Unavailable`, from where it reached, a second later and doubling to 30 seconds, as `client`'s watch does; any other failure, a declared error or a defect, ends its polling.
 * - HTTP's `text/event-stream` whose polling ended on a failure other than a refusal sends `Failed` and opens it again 5 seconds later, from where it reached; MCP's `events/stream` does what `ActionMcp.layerHttp` says of an upstream's failure, a `-32603` before `active`.
 * - A stream's polls, and a poll, MCP's `events/poll` included, hold the subscriber's subscription hook in the entity until its source's `lease` lapses after the last, as on any surface.
 * - A protected event's webhook subscription is held by the entity its input's key names, the subscribe and unsubscribe sent there with the caller's headers, and delivered by the `Webhook.layer` in that entity's `services`, never the serving surface's: an entity without one fails the subscribe with `Event.SubscriptionError`, reason `Unsupported`, a 409 over HTTP, before any callback is sent.
 * - An error the entity declares beyond the action's own and the built-in ones, its binding's `error` or its verifier's, is undeclared where the serving surface's binding does not declare it too.
 */
export const reaching = <
  const Type extends string,
  const B extends ActionRpc.Any,
  N extends Rpc.Any = never,
>(
  entity: Entity<Type, B, N>,
  options: EntityCallOptions = {}
): ReadonlyArray<
  | Implementation<
      B["actions"][number],
      Nothing<B["actions"][number]>,
      never,
      Sharding.Sharding
    >
  | EventImplementation<
      B["events"][number],
      Nothing<B["events"][number]>,
      never,
      Sharding.Sharding
    >
> => {
  const { binding } = entity;

  const reaches = Effect.map(
    entity.client,
    reachOf(entity, forwarded, options)
  );

  const handlerOf = (
    action: Action.Any,
    reach: Reach
  ): WrittenHandler<unknown> => {
    const method = actionMethodOf(action, binding)(reach);

    return (input, reporting) =>
      method(
        input,
        ...(reporting === undefined ? [] : [{ onProgress: reporting.progress }])
      );
  };

  const runOf = (event: Event.Any, reach: Reach): Run => {
    const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(event.input));
    const poll = pollOf(event, binding);
    const watched = watchedOf(event, binding);
    const webhookCalls = webhookCallsOf(event, binding);

    const reached = (input: ErasedValue) =>
      Effect.all([reach(event, input), Effect.orDie(encode(input))]);

    const inEntity = <A>(
      input: ErasedValue,
      sent: (held: WebhookHolder) => Effect.Effect<A, unknown, unknown>
    ) =>
      Effect.flatMap(reach(event, input), (call) => sent(webhookCalls(call)));

    return {
      polls: true,
      webhook: offersWebhook(event)
        ? {
            subscribe: (subscribing) =>
              inEntity(subscribing.input, (held) =>
                held.subscribe(subscribing)
              ),
            unsubscribe: (subscription) =>
              inEntity(subscription.input, (held) =>
                held.unsubscribe(subscription)
              ),
          }
        : undefined,
      poll: (input, cursor, { maxEvents }) =>
        Effect.flatMap(reached(input), ([call, json]) =>
          poll(call)({
            input: json,
            cursor,
            ...(maxEvents === undefined ? {} : { maxEvents }),
          })
        ),
      stream: (input, cursor) =>
        Stream.unwrap(
          Effect.map(reached(input), ([call, json]) => {
            const transport = watched(call)(json);

            return polling(transport, Function.constFalse)(cursor);
          })
        ),
    };
  };

  return [
    ...(binding.actions.length === 0
      ? []
      : [
          new Implementation<
            B["actions"][number],
            Nothing<B["actions"][number]>,
            never,
            Sharding.Sharding
          >(
            binding.actions,
            memoized(
              Effect.map(reaches, (reach): Written =>
                binding.actions.map((action) => [
                  action,
                  handlerOf(action, reach),
                ])
              )
            ),
            memoized(Effect.succeed<ErasedAuthorize>(Action.allowAll))
          ),
        ]),
    ...(binding.events.length === 0
      ? []
      : [
          new EventImplementation<
            B["events"][number],
            Nothing<B["events"][number]>,
            never,
            Sharding.Sharding
          >(
            binding.events,
            binding.events.map(
              (event) =>
                [
                  event,
                  memoized(Effect.map(reaches, (reach) => runOf(event, reach))),
                ] as const
            ),
            memoized(Effect.succeed<ErasedAuthorize<Event.Any>>(Event.allowAll))
          ),
        ]),
  ];
};
