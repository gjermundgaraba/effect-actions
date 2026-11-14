import { Effect, Layer, Predicate, Schema, Stream } from "effect";
import type { Scope } from "effect";
import { ClusterError, Entity as Cluster } from "effect/cluster";
import type { Sharding } from "effect/cluster";
import type { Headers, HttpServerRequest } from "effect/http";
import { Rpc, RpcGroup, RpcMessage } from "effect/rpc";
import type { RpcClient } from "effect/rpc";

import type {
  RemoteRequest,
  ServerBuildServices,
  ServedProvider,
  VerifierError,
} from "../authentication/provider.js";
import * as Action from "../contract/Action.js";
import type { Call } from "../contract/call.js";
import { Anyone } from "../contract/caller.js";
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
import {
  answered,
  elementsOf,
  Implementation,
  memoized,
} from "../contract/implementation.js";
import type {
  ErasedAuthorize,
  ErasedValue,
  Holding,
  Member,
  Served,
  Written,
  WrittenHandler,
} from "../contract/implementation.js";
import { InputCheck } from "../contract/input-check.js";
import type { Reporting } from "../contract/progress.js";
import { buildersOf, servingOf } from "../contract/serving.js";
import { elementOf } from "../contract/stream.js";
import type { Answer } from "../contract/stream.js";
import { Wake } from "../contract/wake.js";
import { polling } from "../contract/watch.js";
import type { WatchArgs } from "../contract/watch.js";
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
import type { ErasedCall } from "../rpc/erased.js";
import { forwarded } from "./forwarded.js";
import { makeWake, wakeTag, WakeRpc } from "./wakes.js";

export { forwardedHeaders } from "./forwarded.js";

type Contract<B extends ActionRpc.Any> =
  | B["actions"][number]
  | B["events"][number];

/**
 * The key of the binding `B`'s actions and event types, the id of the entity that serves a call
 * or a subscription, read from its input: one function of every input, `({ room }) => room`, or
 * one by the name of each action and event type.
 */
export type Keys<B extends ActionRpc.Any> =
  | ((input: Contract<B>["input"]["Type"]) => string)
  | {
      readonly [C in Contract<B> as C["name"]]: (
        input: C["input"]["Type"]
      ) => string;
    };

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
  readonly key: Keys<B>;
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

type ErasedKey = (input: Action.Any["input"]["Type"]) => string;

type ErasedKeys = ErasedKey | { readonly [name: string]: ErasedKey };

const keyOf = (keys: ErasedKeys, name: string): ErasedKey | undefined =>
  Predicate.isFunction(keys) ? keys : keys[name];

const namedBy =
  (keys: ErasedKeys) =>
  (
    contract: Action.Any | Event.Any,
    input: Action.Any["input"]["Type"]
  ): string | undefined => {
    const named: unknown = keyOf(keys, contract.name)?.(input);

    return Predicate.isString(named) ? named : undefined;
  };

type WithoutNatives<B extends ActionRpc.Any> = [
  RpcGroup.Rpcs<B["rpcs"]>,
] extends [never]
  ? unknown
  : {
      readonly "An entity's binding holds no native rpcs: give them to ActionEntity.make's rpcs": never;
    };

/** `make`'s options. */
export interface MakeOptions<B extends ActionRpc.Any, N extends Rpc.Any> {
  /**
   * The entity id an input names: one function every action and event input of the binding
   * reads, `({ room }) => room`, or, where their inputs differ, one by the name of each,
   * `{ postMessage: ({ room }) => room }`.
   *
   * **Gotchas**
   *
   * - One function takes the union of the binding's inputs, so it reads only a field every one declares: a field one input lacks is a type error.
   * - By name, every action and event type needs a key: one left out is a type error, and throws as the entity is made.
   */
  readonly key: Keys<B>;
  /**
   * The entity's own native rpcs, beside its actions and event types, with their own schemas:
   * `RpcGroup.make(Expire)`, such as a persisted tell the entity sends itself with `DeliverAt`.
   * `layer` takes their handlers in its own `rpcs`.
   *
   * **Gotchas**
   *
   * - A native rpc authenticates nothing, whatever the binding's `authentication`: it is for tells the entity and other entities send with `Entity.client`, never for a surface's callers.
   * - A native rpc named after an action, an event type, or an event's `<event>/poll` or `<event>/release` throws as the entity is made.
   */
  readonly rpcs?: RpcGroup.RpcGroup<N> | undefined;
}

/**
 * The cluster entity of type `type` serving the actions and event types of `binding`, an
 * `ActionRpc` binding, each call and subscription in the entity its contract's `key` names for
 * its input. Each event type is a unary rpc named `<event>/poll`, `ActionRpc.pollTag`, taking
 * `{ input, cursor, maxEvents, watch }` and answering a page,
 * `{ events, cursor, truncated, hasMore, nextPollMs }`, as an HTTP poll does, and one named
 * `<event>/release`, taking `{ input, watch }`, as `ActionRpc.layer` serves them too: polls naming a `watch`, a UUID, hold a
 * subscription hook of their own, keyed by it and their caller's principal, which its release by
 * that principal frees. A protected event type has two more, `<event>/subscribe` and
 * `<event>/unsubscribe`, taking a webhook subscription and its cancellation, and the entity has
 * its wake, `effect-actions/wake`, a persisted tell it sends itself to end a webhook delivery's
 * retry wait. Guide: `docs/ActionEntity.md` in this package.
 *
 * **Gotchas**
 *
 * - The rpcs of its actions, event types and webhook subscriptions are volatile, as `ClusterSchema.Persisted` defaults, and its wake alone is persisted: annotated persisted, each envelope, its caller's headers and credential included, would be stored and replayed with them, on Effect's SQL runners until a `MessageRetention` layer deletes it, and on the Cloudflare runtime, which never prunes `cluster_messages`, for good, its credential headers redacted. `rpcs`' natives are persisted as their own annotations say.
 * - A binding with native rpcs throws: give the entity's own rpcs to `make`'s `rpcs`.
 * - A streaming action, one declaring `progress` or answering `Action.Stream`, is a stream rpc, its frames those `ActionRpc.make` states, `client`'s method handing each progress value to `onProgress` before it answers, and returning a `Stream` of the elements of an `Action.Stream` answer; it holds a slot of the entity's `concurrency`, by default its only one, until its stream ends, but on the Cloudflare runtime, which frees the slot while a frame waits for its client's acknowledgement.
 * - `annotate` and its kin return a plain `Entity`, without `binding` and `key`, which `layer` and `client` do not take.
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

  const keys: ErasedKeys = options.key;

  const unkeyed = [...binding.actions, ...binding.events].filter(
    ({ name }) => !Predicate.isFunction(keyOf(keys, name))
  );

  if (unkeyed.length > 0) {
    throw new Error(
      `ActionEntity.make: key holds none for ${unkeyed.map(({ name }) => name).join(", ")} (give key one function of every input, or one for each action and event type of the binding, by name)`
    );
  }

  const erased = erasedOf(binding.actions, binding.events, ["poll"])
    .merge(webhookRpcsOf(binding.events))
    .add(WakeRpc);

  const rpcs = options.rpcs ?? RpcGroup.make();

  const taken = [...rpcs.requests.keys()].filter(
    (tag) =>
      erased.requests.has(tag) ||
      binding.events.some(({ name }) => name === tag)
  );

  if (taken.length > 0) {
    throw new Error(
      `ActionEntity.make: the native rpcs of ${type}, ${taken.join(", ")}, are named after an action, an event type, an event's poll, release, subscribe or unsubscribe, or the entity's wake, ${wakeTag} (rename them)`
    );
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const protocol = erased.merge(rpcs) as RpcGroup.RpcGroup<ErasedRpc | N>;

  return Object.assign(Cluster.fromRpcGroup(type, protocol), {
    binding,
    key: options.key,
  });
};

/**
 * The rpcs of `entity`'s binding, as its `protocol` holds them without its native rpcs: one per
 * action, and per event type its poll and its `<event>/release`. What a surface outside the
 * cluster may forward to the entity, as the Cloudflare package's socket host does, which
 * `ActionRpc.client`'s watch polls, finding no stream rpc.
 */
export const bindingRpcs = (entity: Any): RpcGroup.RpcGroup<ErasedRpc> =>
  erasedOf(entity.binding.actions, entity.binding.events, ["poll"]);

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
   * - A `Webhook.layer` here holds the entity's webhook subscriptions and delivers them from its activation: give it `persist`, so a later activation restores them; each retry wait is a wake the entity sends itself, so a stopped entity is built again to retry, on Effect's SQL runners up to `entityMessagePollInterval` after it is due, each wake a row of the runtime's messages, kept once processed.
   * - A webhook subscription to a check source not `notified` is refused with `Event.SubscriptionError`, reason `Unsupported`, and a warning saying why, its polls and unsubscribes still served: its reads on a timer would be cut by Effect's reaper and keep a Durable Object awake.
   * - A webhook subscription past its expiry ends at its next delivery, and its kept record at the next activation, on no timer: until then it holds its subscription hook.
   * - A `Webhook.layer` here with `persist` needs the binding's authentication to name a `schema` where it serves a protected event whose source is no check source left un-`notified`: without one each activation dies with the library's message naming `schema`, so on Effect's runners each call to the entity waits while the runner builds it again, and on the Cloudflare runtime each fails at once.
   */
  readonly services?: Layer.Layer<ROut, unknown, RIn> | undefined;
  /**
   * The handlers of `make`'s `rpcs`, as `Entity.toLayer` takes them: an `Entity.HandlersFrom` of
   * those rpcs, or an Effect building one as each entity id activates, after `services`, whose
   * output it and the handlers' answers read. Each handler receives Effect's own `Entity.Request`,
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
}

type NativeLayerOptions<N extends Rpc.Any, ROut, RIn, Handlers, RX> = [
  N,
] extends [never]
  ? [options?: LayerOptions<ROut, RIn>]
  : [
      options: LayerOptions<ROut, RIn, Handlers, RX> & {
        readonly rpcs: Handlers | Effect.Effect<Handlers, never, RX>;
      },
    ];

type Activation =
  | Cluster.CurrentAddress
  | Cluster.CurrentRunnerAddress
  | Scope.Scope;

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
  ROut = never,
  RIn = never,
  Handlers extends Cluster.HandlersFrom<N> = never,
  RX = never,
>(
  entity: Entity<Type, B, N>,
  implementations: Apps & NoPerCall<B, Apps, ROut>,
  ...options: NativeLayerOptions<N, ROut, RIn, Handlers, RX>
): EntityLayer<B, Apps, N, ROut, RIn, Handlers, RX>;
export function layer<Type extends string, B extends ActionRpc.Any>(
  entity: Entity<Type, B, Rpc.Any>,
  served: Served,
  {
    services = Layer.empty,
    rpcs = {},
    ...options
  }: LayerOptions<
    never,
    unknown,
    Readonly<Record<string, NativeHandler>>,
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

    const { wake, woke } = yield* makeWake((payload) =>
      Effect.flatMap(entity.client, (clientFor) => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const self = clientFor(address.entityId) as RpcClient.RpcClient<
          typeof WakeRpc
        >;

        return self[wakeTag](payload, { discard: true });
      }).pipe(Effect.provideContext(sharding))
    );

    const built = yield* Layer.buildWithMemoMap(
      first === undefined
        ? services
        : Layer.provideMerge(Layer.mergeAll(first, ...rest), services),
      Layer.makeMemoMapUnsafe(),
      yield* Effect.scope
    ).pipe(Effect.provideService(Wake, wake));

    const { handlers } = yield* Effect.provideContext(
      handlersOf(binding, {
        apps,
        events,
        authentication,
        middleware: [],
        server: "ActionEntity.layer",
      }),
      built
    );

    const check = (
      contract: Action.Any | Event.Any,
      input: Action.Any["input"]["Type"]
    ) => {
      const entityId = named(contract, input);

      return entityId === address.entityId
        ? Effect.void
        : Effect.fail(
            new Action.Forbidden({
              message: `This entity is ${address.entityType}/${address.entityId}, and the input of ${contract.name} names ${entityId ?? "none"}`,
            })
          );
    };

    const natives = yield* Effect.provideContext(
      Effect.isEffect(rpcs) ? rpcs : Effect.succeed(rpcs),
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
          return [rpc._tag, woke] as const;
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

              return answer.pipe(
                Effect.provideService(InputCheck, check),
                Effect.provideContext(built)
              );
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

const Transients = Schema.Union([
  ClusterError.MailboxFull,
  ClusterError.PersistenceError,
]);

const ClusterFailures = Schema.Union([
  ...Transients.members,
  ClusterError.AlreadyProcessingMessage,
  ClusterError.EntityNotAssignedToRunner,
]);

type ClusterFailure = typeof ClusterFailures.Type;

/**
 * Whether a failure is one of those Effect's entity client fails with when the entity could not
 * be reached, `MailboxFull`, `PersistenceError`, `AlreadyProcessingMessage` and
 * `EntityNotAssignedToRunner`, which `client`'s `MethodError` holds and `reaching` makes a
 * defect: a server forwarding calls into an entity, as the Cloudflare package's socket host
 * does, makes them one too.
 */
export const isClusterFailure = Schema.is(ClusterFailures);

const isTransient = Schema.is(Transients);

/**
 * What one call of an action `A` fails with, beside the binding's errors `E`: its declared and
 * built-in errors, and what Effect's entity client fails with when the entity could not be
 * reached. An answer that does not decode is a defect.
 */
export type MethodError<
  A extends Action.Any,
  E extends Action.Errors[number] = never,
> = A["error"][number]["Type"] | E["Type"] | BuiltIns["Type"] | ClusterFailure;

type Method<A extends Action.Any, E extends Action.Errors[number]> = Call<
  A,
  Answer<A["success"], MethodError<A, E>, never>
>;

/**
 * What a watch of `W` over the binding `B` may fail with: a refusal, `InvalidInput`, the
 * binding's errors, an `Event.SubscriptionError` (`Unsupported` for `mode: "stream"`, since an
 * entity serves polls, `NotServed` for an event the entity does not serve), or what Effect's
 * entity client fails with that no retry outlasts.
 */
export type WatchError<W extends Event.Any, B extends ActionRpc.Any> =
  | Event.SubscriptionError
  | BuiltIns["Type"]
  | B["error"][number]["Type"]
  | VerifierError<W, B["authentication"]>["Type"]
  | ClusterFailure;

type Watching<B extends ActionRpc.Any> = [B["events"][number]] extends [never]
  ? unknown
  : {
      readonly watch: <W extends B["events"][number], SE = never>(
        event: W,
        ...args: WatchArgs<W, SE>
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

const entityCallOf = (
  rpcs: ReturnType<Effect.Success<Cluster.Entity<string, ErasedRpc>["client"]>>,
  headers?: Headers.Headers
): ErasedCall =>
  erasedCallOf((tag, payload, options) => {
    const method = rpcs[tag];

    return method === undefined
      ? Effect.die(new Error(`ActionEntity: no rpc ${tag}`))
      : method(payload, headers === undefined ? options : { headers });
  });

/**
 * The client of `entity` over Effect's own `Entity.client`, as a function of an entity id: one
 * method per action taking its input, `rooms("lobby").postMessage({ room: "lobby", text })`, and
 * `watch(event, input, options)`, which polls the event's rpc. Requires `Sharding`, as
 * `Entity.client` does: `TestRunner.layer` in a test.
 *
 * **Gotchas**
 *
 * - The id must be the one the input's key names: another fails the call with `Forbidden`, before the handler runs.
 * - Headers set with `RpcClient.withHeaders` around a call go with its envelope, which is how a protected call sends its credential; a call without them fails `Unauthenticated`.
 * - A watch polls, by default as with `mode: "poll"`, at the page's `nextPollMs`, its polls holding a subscription hook of their own in the entity, which its end releases; `mode: "stream"` fails with `Event.SubscriptionError`, reason `Unsupported`, and a webhook `mode` with it too.
 * - Ending a watch waits up to 5 seconds for the entity to answer its release, so interrupting one whose entity is slow to answer, such as one with a full mailbox, takes up to 5 seconds; a release that never arrives leaves the hook held until the entity stops or its source's `lease` lapses.
 * - A watch asks the entity again after `MailboxFull` or `PersistenceError`, from where it reached, a second later and doubling to 30 seconds; a declared error, a refusal included, ends it.
 */
export const client = <
  const Type extends string,
  const B extends ActionRpc.Any,
  N extends Rpc.Any = never,
>(
  entity: Entity<Type, B, N>
): Effect.Effect<(entityId: string) => Client<B>, never, Sharding.Sharding> => {
  const methods = methodsOf(entity.binding, polledTransport(isTransient));

  return Effect.map(
    entity.client,
    (clientFor) => (entityId: string) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      methods(entityCallOf(clientFor(entityId))) as Client<B>
  );
};

type Nothing<C extends Action.Any | Event.Any> = {
  readonly [K in C["name"]]: never;
};

/**
 * The implementations of `entity`'s actions and event types that any surface serves beside its
 * own, `ActionHttp.layer`, `ActionRpc.layer` or `ActionMcp.layerHttp`: each call sent through
 * `Entity.client` to the entity its contract's key names for its input, with the caller's
 * headers, and its answer, declared errors and progress passed back; each event followed through
 * the entity's poll rpc.
 *
 * **Gotchas**
 *
 * - The caller's credential is verified by the surface serving these and again by the entity reached, so both are given the verifier: a call the surface refuses reaches no entity.
 * - A refusal by the entity, a credential expired since the surface verified it included, ends a stream after it answered 200, where the surface's own refusal would have answered its 401 or 403.
 * - The caller's request's headers are sent on as `forwardedHeaders` keeps them: its connection's, its body's, what it accepts and an MCP request's routing headers are not.
 * - A credential in the query, an API key the serving surface's HTTP binding reads `in: "query"`, never reaches the entity, whose binding reads headers alone, so it refuses the call with `Unauthenticated`: read the key from a header on the HTTP binding too.
 * - A call with no HTTP request, as through `Action.client` in process or an MCP stdio surface, sends only the headers `RpcClient.withHeaders` sets around it: without them the entity refuses a protected one with `Unauthenticated`.
 * - A call to an entity no runner is assigned waits without an answer, an HTTP request without a response, as Effect's entity client retries `EntityNotAssignedToRunner` every `sendRetryInterval`, 100 milliseconds by default, without limit: bound it with a timeout, such as the host's request timeout.
 * - A stream, HTTP's `text/event-stream`, an RPC subscription or MCP's `events/stream`, polls the entity from the surface, at once while a page has more and otherwise at its `nextPollMs`, a second at least: it holds the caller's request open but no entity, an occurrence arrives up to that interval late, and the entity's object takes a call each `nextPollMs` while the stream is open, so on Cloudflare a stream polling every few seconds keeps it from ever hibernating.
 * - A stream asks the entity again after `MailboxFull` or `PersistenceError`, from where it reached, a second later and doubling to 30 seconds, as `client`'s watch does; any other failure, a declared error or a defect, ends its polling.
 * - HTTP's `text/event-stream` whose polling ended on a failure other than a refusal sends `Failed` and opens it again 5 seconds later, from where it reached; MCP's `events/stream` does what `ActionMcp.layerHttp` says of an upstream's failure, a `-32603` before `active`.
 * - A stream's polls hold a subscription hook of their own in the entity, which its end releases, as `client`'s watch does; a poll, MCP's `events/poll` included, holds the subscriber's until its source's `lease` lapses, as on any surface.
 * - A protected event's webhook subscription is held by the entity its input's key names, the subscribe and unsubscribe sent there with the caller's headers, and delivered by the `Webhook.layer` in that entity's `services`, never the serving surface's: an entity without one fails the subscribe with `Event.SubscriptionError`, reason `Unsupported`, a 409 over HTTP, before any callback is sent.
 * - What `Entity.client` fails with, `MailboxFull`, `AlreadyProcessingMessage`, `PersistenceError` or `EntityNotAssignedToRunner`, is the call's defect, carrying that error alone, since no action declares it: a 500 over HTTP and a defect through `Action.client`, never a typed error.
 * - An error the entity declares beyond the action's own and the built-in ones, its binding's `error` or its verifier's, is undeclared where the serving surface's binding does not declare it too.
 */
export const reaching = <
  const Type extends string,
  const B extends ActionRpc.Any,
  N extends Rpc.Any = never,
>(
  entity: Entity<Type, B, N>
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
  const named = namedBy(entity.key);

  type Reach = (
    contract: Action.Any | Event.Any,
    input: ErasedValue
  ) => Effect.Effect<ErasedCall, Action.Forbidden>;

  const reaches = Effect.map(
    entity.client,
    (clientFor): Reach =>
      (contract, input) => {
        const entityId = named(contract, input);

        return entityId === undefined
          ? Effect.fail(
              new Action.Forbidden({
                message: `The input of ${contract.name} names no entity of ${entity.type}`,
              })
            )
          : Effect.map(forwarded, (headers) =>
              entityCallOf(clientFor(entityId), headers)
            );
      }
  );

  const handlerOf = (
    action: Action.Any,
    reach: Reach
  ): WrittenHandler<unknown> => {
    const method = actionMethodOf(action, binding);

    const answer = (input: ErasedValue, reporting: Reporting | undefined) =>
      Effect.map(reach(action, input), (call) =>
        method(call)(
          input,
          ...(reporting === undefined
            ? []
            : [{ onProgress: reporting.progress }])
        )
      );

    return elementOf(action.success) === undefined
      ? (input, reporting) =>
          Effect.flatMap(answer(input, reporting), answered).pipe(
            Effect.catchIf(isClusterFailure, Effect.die)
          )
      : (input, reporting) =>
          elementsOf(answer(input, reporting)).pipe(
            Stream.catchIf(isClusterFailure, Stream.die)
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
      Effect.flatMap(reach(event, input), (call) =>
        sent(webhookCalls(call))
      ).pipe(Effect.catchIf(isClusterFailure, Effect.die));

    return {
      polls: true,
      webhook:
        event.caller === Anyone
          ? undefined
          : {
              subscribe: (subscribing) =>
                inEntity(subscribing.input, (held) =>
                  held.subscribe(subscribing)
                ),
              unsubscribe: (subscription) =>
                inEntity(subscription.input, (held) =>
                  held.unsubscribe(subscription)
                ),
            },
      poll: (input, cursor, { maxEvents }) =>
        Effect.flatMap(reached(input), ([call, json]) =>
          poll(call)({
            input: json,
            cursor,
            ...(maxEvents === undefined ? {} : { maxEvents }),
          })
        ).pipe(Effect.catchIf(isClusterFailure, Effect.die)),
      stream: (input, cursor) =>
        Stream.unwrap(
          Effect.map(reached(input), ([call, json]) =>
            polling(watched(call)(json), isTransient)(cursor)
          )
        ).pipe(Stream.catchIf(isClusterFailure, Stream.die)),
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
