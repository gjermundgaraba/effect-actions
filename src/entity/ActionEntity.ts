import { Context, Effect, Layer, Predicate, Schema } from "effect";
import type { Scope, Stream } from "effect";
import { ClusterError, Entity as Cluster } from "effect/cluster";
import type { Sharding } from "effect/cluster";
import type { HttpServerRequest } from "effect/http";
import type { RpcGroup } from "effect/rpc";

import type {
  RemoteRequest,
  ServerBuildServices,
  ServedProvider,
  VerifierError,
} from "../authentication/provider.js";
import * as Action from "../contract/Action.js";
import type { Call } from "../contract/call.js";
import type { BuiltIns } from "../contract/errors.js";
import type * as Event from "../contract/Event.js";
import type {
  EventBuildServices,
  EventServedRequest,
  HoldingEvents,
  ServingEvents,
} from "../contract/feed.js";
import type { Holding, Member, Served } from "../contract/implementation.js";
import { InputCheck } from "../contract/input-check.js";
import { buildersOf, servingOf } from "../contract/serving.js";
import type { Answer } from "../contract/stream.js";
import type { WatchArgs } from "../contract/watch.js";
import type * as ActionRpc from "../rpc/ActionRpc.js";
import {
  erasedOf,
  handlersOf,
  methodsOf,
  nativeOf,
  polledTransport,
} from "../rpc/erased.js";
import type { ErasedCall } from "../rpc/erased.js";

type Contract<B extends ActionRpc.Any> =
  | B["actions"][number]
  | B["events"][number];

/**
 * The key of each action and event type of the binding `B`, by its name: the id of the entity
 * that serves a call or a subscription, read from its input.
 */
export type Keys<B extends ActionRpc.Any> = {
  readonly [C in Contract<B> as C["name"]]: (
    input: C["input"]["Type"]
  ) => string;
};

type ErasedRpc =
  ReturnType<typeof erasedOf> extends RpcGroup.RpcGroup<infer R> ? R : never;

/**
 * A cluster `Entity` serving an `ActionRpc` binding: one rpc of JSON per action, and per event
 * type one unary rpc answering a page past a cursor, plus the binding and the key of each of its
 * contracts. `layer` serves it, `client` calls it, and Effect's own `Entity` functions take it.
 */
export interface Entity<
  Type extends string,
  B extends ActionRpc.Any,
> extends Cluster.Entity<Type, ErasedRpc> {
  readonly binding: B;
  readonly key: Keys<B>;
}

interface ErasedKeys {
  readonly [name: string]: (input: Action.Any["input"]["Type"]) => string;
}

type WithoutNatives<B extends ActionRpc.Any> = [
  RpcGroup.Rpcs<B["rpcs"]>,
] extends [never]
  ? unknown
  : { readonly "An entity serves no native rpcs": never };

/** `make`'s options. */
export interface MakeOptions<B extends ActionRpc.Any> {
  /**
   * By the name of each action and event type of the binding, the entity id its input names:
   * `{ PostMessage: ({ room }) => room }`. Every one needs a key.
   */
  readonly key: Keys<B>;
}

/**
 * The cluster entity of type `type` serving the actions and event types of `binding`, an
 * `ActionRpc` binding, each call and subscription in the entity its contract's `key` names for
 * its input. Each event type is a unary rpc named after it, taking `{ input, cursor, maxEvents }`
 * and answering a page, `{ events, cursor, truncated, hasMore, nextPollMs }`, as an HTTP poll
 * does. Guide: `docs/ActionEntity.md` in this package.
 *
 * **Gotchas**
 *
 * - Every rpc is volatile, as `ClusterSchema.Persisted` defaults: annotating them persisted writes each envelope, its caller's headers and credential included, into `cluster_messages` for good, and replays it with them.
 * - A binding with native rpcs throws: serve them from an `Entity` of their own.
 * - A streaming action, one declaring `progress` or answering `Action.Stream`, is a stream rpc that holds the entity's one concurrency slot until its stream ends.
 * - `annotate` and its kin return a plain `Entity`, without `binding` and `key`, which `layer` and `client` do not take.
 */
export const make = <const Type extends string, const B extends ActionRpc.Any>(
  type: Type,
  binding: B & WithoutNatives<B>,
  options: NoInfer<MakeOptions<B>>
): Entity<Type, B> => {
  const natives = [...nativeOf(binding.rpcs).requests.keys()];

  if (natives.length > 0) {
    throw new Error(
      `ActionEntity.make: the binding of ${type} holds native rpcs, ${natives.join(", ")} (serve them from an Entity of their own)`
    );
  }

  const keys: ErasedKeys = options.key;

  const unkeyed = [...binding.actions, ...binding.events].filter(
    ({ name }) => !Predicate.isFunction(keys[name])
  );

  if (unkeyed.length > 0) {
    throw new Error(
      `ActionEntity.make: key holds none for ${unkeyed.map(({ name }) => name).join(", ")} (give key a function for each action and event type of the binding, by name)`
    );
  }

  return Object.assign(
    Cluster.fromRpcGroup(
      type,
      erasedOf(binding.actions, binding.events, "poll")
    ),
    { binding, key: options.key }
  );
};

/**
 * `layer`'s options: `Entity.toLayer`'s, which the entity's registration takes, but
 * `disableFatalDefects`, which is always on.
 */
export type LayerOptions = Omit<
  NonNullable<Parameters<Cluster.Any["toLayer"]>[1]>,
  "disableFatalDefects"
>;

type Activation =
  | HttpServerRequest.HttpServerRequest
  | HttpServerRequest.ParsedSearchParams
  | Cluster.CurrentAddress
  | Cluster.CurrentRunnerAddress
  | Scope.Scope;

type EntityLayer<
  B extends ActionRpc.Any,
  Apps extends Served,
  A extends Action.Any = B["actions"][number],
  E extends Event.Any = B["events"][number],
> = Layer.Layer<
  never,
  never,
  | Exclude<
      | ServerBuildServices<Holding<Member<Apps>, A>, A>
      | EventBuildServices<HoldingEvents<Member<Apps>, E>, E>
      | RemoteRequest<Member<Apps>, A>
      | EventServedRequest<Member<Apps>, E>,
      Activation
    >
  | ServedProvider<
      Member<Apps>,
      A,
      B extends { readonly authentication: infer D } ? D : never,
      ServingEvents<Member<Apps>, E>
    >
  | Sharding.Sharding
>;

/**
 * Register `entity` with the cluster's `Sharding`, serving its binding's actions and event types
 * from `implementations`, which implement every one. Each entity id builds the implementations
 * itself as it activates, so a builder may read `Entity.CurrentAddress`; each message of a
 * protected one authenticates from its envelope's headers with the binding's descriptor, as
 * `ActionRpc.layer`'s does; then the input decodes, an input whose key names another entity is
 * refused with `Forbidden`, and the implementation's `authorize` and the handler run.
 *
 * **Gotchas**
 *
 * - What the application provides to this layer is shared by every entity of the runner; what an implementation builds, each entity id builds for itself: state held in a builder is that entity's alone.
 * - A builder that fails or dies is a defect of the entity's activation, logged and retried by `defectRetryPolicy` while its calls wait: it never fails the layer.
 * - A handler's defect or undeclared failure ends that call with an `Error` whose message is `Internal server error`, as on `ActionRpc.layer`; the entity is neither restarted nor its call replayed, so its next call runs on the same handlers.
 * - A call's headers are what its client sent: one through `Entity.client` sends those `RpcClient.withHeaders` sets around it, and none otherwise, so a protected call fails `Unauthenticated`.
 * - An implementation missing for one of the binding's actions or event types throws as the layer is made: an entity serves its whole binding.
 */
export function layer<
  const Type extends string,
  const B extends ActionRpc.Any,
  const Apps extends Served,
>(
  entity: Entity<Type, B>,
  implementations: Apps,
  options?: LayerOptions
): EntityLayer<B, Apps>;
export function layer<Type extends string, B extends ActionRpc.Any>(
  entity: Entity<Type, B>,
  served: Served,
  options: LayerOptions = {}
): Layer.Layer<never, never, unknown> {
  const { binding } = entity;
  const key: ErasedKeys = entity.key;

  const { apps, events, authentication } = servingOf(
    "ActionEntity binding",
    binding,
    served,
    { actions: [...binding.actions, ...binding.events] }
  );

  const [first, ...rest] = buildersOf(apps, events);

  const build = Effect.gen(function* () {
    const address = yield* Cluster.CurrentAddress;

    const built =
      first === undefined
        ? Context.empty()
        : yield* Layer.buildWithMemoMap(
            Layer.mergeAll(first, ...rest),
            Layer.makeMemoMapUnsafe(),
            yield* Effect.scope
          );

    const { handlers } = yield* Effect.provideContext(
      handlersOf(binding, {
        apps,
        events,
        authentication,
        middleware: [],
        keeper: undefined,
        delivery: "poll",
      }),
      built
    );

    const check = (
      contract: Action.Any | Event.Any,
      input: Action.Any["input"]["Type"]
    ) => {
      const named = key[contract.name]?.(input);

      return named === undefined || named === address.entityId
        ? Effect.void
        : Effect.fail(
            new Action.Forbidden({
              message: `This entity is ${address.entityType}/${address.entityId}, and the input of ${contract.name} names ${named}`,
            })
          );
    };

    return Object.fromEntries(
      Object.entries(handlers).map(([tag, handler]) => [
        tag,
        (
          request: Cluster.Request<ErasedRpc>,
          call: Parameters<typeof handler>[1]
        ) => {
          const answer: Effect.Effect<unknown, unknown, unknown> = handler(
            request.payload,
            call
          );

          return Effect.provideService(answer, InputCheck, check);
        },
      ])
    );
  }).pipe(Effect.orDie);

  return entity.toLayer(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    build as Effect.Effect<Cluster.HandlersFrom<ErasedRpc>>,
    { ...options, disableFatalDefects: true }
  );
}

type ClusterFailure =
  | ClusterError.MailboxFull
  | ClusterError.AlreadyProcessingMessage
  | ClusterError.PersistenceError
  | ClusterError.EntityNotAssignedToRunner;

const isTransient = Schema.is(
  Schema.Union([
    ClusterError.MailboxFull,
    ClusterError.PersistenceError,
    ClusterError.EntityNotAssignedToRunner,
  ])
);

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

/**
 * The client of `entity` over Effect's own `Entity.client`, as a function of an entity id: one
 * method per action taking its input, `rooms("lobby").postMessage({ room: "lobby", text })`, and
 * `watch(event, input, options)`, which polls the event's rpc. Requires `Sharding`, as
 * `Entity.client` does: `TestRunner.layer` in a test.
 *
 * **Gotchas**
 *
 * - The id must be the one the input's key names: another fails the call with `Forbidden`, before the handler runs.
 * - Headers set with `RpcClient.withHeaders` around a call go with its envelope, which is how a protected call sends its credential.
 * - A watch polls, as `mode: "poll"` does over HTTP, at the page's `nextPollMs`; `mode: "stream"` fails with `Event.SubscriptionError`, reason `Unsupported`, and a webhook `mode` with it too.
 * - A watch retries after `MailboxFull`, `PersistenceError` and `EntityNotAssignedToRunner`, a second later and doubling to 30 seconds; a declared error, a refusal included, ends it.
 */
export const client = <
  const Type extends string,
  const B extends ActionRpc.Any,
>(
  entity: Entity<Type, B>
): Effect.Effect<(entityId: string) => Client<B>, never, Sharding.Sharding> =>
  Effect.map(entity.client, (clientFor) => (entityId: string) => {
    const rpcs = clientFor(entityId);

    const call: ErasedCall = (tag, payload, options) => {
      const method = rpcs[tag];

      return method === undefined
        ? Effect.die(new Error(`ActionEntity.client: no rpc ${tag}`))
        : method(payload, options);
    };

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return methodsOf(
      entity.binding,
      call,
      polledTransport(isTransient)
    ) as Client<B>;
  });
