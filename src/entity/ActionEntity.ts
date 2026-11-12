import { Context, Effect, Layer, Predicate, Schema, Stream } from "effect";
import type { Scope } from "effect";
import { ClusterError, Entity as Cluster } from "effect/cluster";
import type { Sharding } from "effect/cluster";
import { Headers } from "effect/http";
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
import * as Event from "../contract/Event.js";
import { EventImplementation } from "../contract/feed.js";
import type {
  EventBuildServices,
  EventServedRequest,
  HoldingEvents,
  Run,
  ServingEvents,
} from "../contract/feed.js";
import { forwarded } from "../contract/forwarded.js";
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
import { InputCheck } from "../contract/input-check.js";
import { paged } from "../contract/pages.js";
import { buildersOf, servingOf } from "../contract/serving.js";
import type { Answer } from "../contract/stream.js";
import type { WatchArgs } from "../contract/watch.js";
import type * as ActionRpc from "../rpc/ActionRpc.js";
import {
  actionMethodOf,
  erasedOf,
  handlersOf,
  methodsOf,
  nativeOf,
  polledTransport,
  pollOf,
  streams,
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
 * - Every rpc is volatile, as `ClusterSchema.Persisted` defaults: annotating them persisted writes each envelope, its caller's headers and credential included, into `cluster_messages`, kept until a `MessageRetention` layer deletes it, and replays it with them.
 * - A binding with native rpcs throws: serve them from an `Entity` of their own.
 * - A streaming action, one declaring `progress` or answering `Action.Stream`, is a stream rpc, its frames those `ActionRpc.make` states, `client`'s method handing each progress value to `onProgress` before it answers, and returning a `Stream` of the elements of an `Action.Stream` answer; it holds the entity's one concurrency slot until its stream ends.
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
  | Cluster.CurrentAddress
  | Cluster.CurrentRunnerAddress
  | Scope.Scope;

type PerCall<
  B extends ActionRpc.Any,
  Apps extends Served,
  A extends Action.Any = B["actions"][number],
  E extends Event.Any = B["events"][number],
> = Exclude<
  RemoteRequest<Member<Apps>, A> | EventServedRequest<Member<Apps>, E>,
  | Activation
  | HttpServerRequest.HttpServerRequest
  | HttpServerRequest.ParsedSearchParams
>;

type NoPerCall<B extends ActionRpc.Any, Apps extends Served> = [
  PerCall<B, Apps>,
] extends [never]
  ? unknown
  : {
      readonly "An entity provides no service per call: yield it in the implementation's builder, where it is a startup service": PerCall<
        B,
        Apps
      >;
    };

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
      | EventBuildServices<HoldingEvents<Member<Apps>, E>, E>,
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
 * itself as it activates, so a builder may read `Entity.CurrentAddress`; each call of a
 * protected one authenticates from the headers its client sent with the binding's descriptor, as
 * `ActionRpc.layer`'s does; then the input decodes, failing `InvalidInput` where it does not, an
 * input whose key names another entity or none is refused with `Forbidden`, and the
 * implementation's `authorize` and the handler run; a declared error is the call's typed failure.
 *
 * **Gotchas**
 *
 * - What the application provides to this layer is shared by every entity of the runner; what an implementation builds, each entity id builds for itself: state held in a builder is that entity's alone.
 * - A handler, an authorizer or an event source reading per call a service other than its caller is a type error naming that service: an entity provides nothing per call, so yield it in the builder, where it is a startup service, one value for every caller and entity id.
 * - `Action.layer` above it shares no build with it: each entity id runs its implementations' builders again, beside the run `Action.layer` made for the other surfaces.
 * - A builder that fails or dies is a defect of the entity's activation, logged and retried by `defectRetryPolicy` while its calls wait: it never fails the layer.
 * - A handler's defect or undeclared failure ends that call with an `Error` whose message is `Internal server error`, as on `ActionRpc.layer`; the entity is neither restarted nor its call replayed, so its next call runs on the same handlers.
 * - An implementation missing for one of the binding's actions or event types throws as the layer is made: an entity serves its whole binding.
 */
export function layer<
  const Type extends string,
  const B extends ActionRpc.Any,
  const Apps extends Served,
>(
  entity: Entity<Type, B>,
  implementations: Apps & NoPerCall<B, Apps>,
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
      const named: unknown = key[contract.name]?.(input);

      return named === address.entityId
        ? Effect.void
        : Effect.fail(
            new Action.Forbidden({
              message: `This entity is ${address.entityType}/${address.entityId}, and the input of ${contract.name} names ${Predicate.isString(named) ? named : "none"}`,
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
 * - Headers set with `RpcClient.withHeaders` around a call go with its envelope, which is how a protected call sends its credential; a call without them fails `Unauthenticated`.
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

type Nothing<C extends Action.Any | Event.Any> = {
  readonly [K in C["name"]]: never;
};

const Reached = Context.Reference<string | undefined>(
  "effect-actions/ActionEntity/Reached",
  { defaultValue: () => undefined }
);

const unredacted = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, Headers.CurrentRedactedNames, []);

const reachedCall = (
  clientFor: Effect.Success<Cluster.Entity<string, ErasedRpc>["client"]>,
  streaming: ReadonlySet<string>
): ErasedCall => {
  const send = (tag: string, payload: Schema.Json) =>
    Effect.flatMap(Effect.all([Reached, forwarded]), ([entityId, headers]) => {
      const method =
        entityId === undefined ? undefined : clientFor(entityId)[tag];

      return method === undefined
        ? Effect.die(new Error(`ActionEntity.reaching: no entity for ${tag}`))
        : Effect.succeed(method(payload, { headers }));
    });

  return (tag, payload) =>
    streaming.has(tag)
      ? Stream.unwrap(
          Effect.map(send(tag, payload), (answer) =>
            Stream.isStream(answer)
              ? Stream.provideService(answer, Headers.CurrentRedactedNames, [])
              : Stream.fromEffect(unredacted(answer))
          )
        )
      : Effect.flatMap(send(tag, payload), (answer) =>
          Stream.isStream(answer)
            ? Effect.die(new Error(`ActionEntity.reaching: ${tag} streams`))
            : unredacted(answer)
        );
};

/**
 * The implementations of `entity`'s actions and event types that any surface serves beside its
 * own, `ActionHttp.layer`, `ActionRpc.layer` or `ActionMcp.layerHttp`: each call sent through
 * `Entity.client` to the entity its contract's key names for its input, with the caller's
 * headers, and its answer, declared errors and progress passed back; each event followed through
 * the entity's poll rpc. The surface authenticates a protected one as its own and authorizes every
 * caller; the entity reached authenticates and authorizes again. Building them requires
 * `Sharding`.
 *
 * **Gotchas**
 *
 * - The caller's credential is verified twice, by the surface serving these and by the entity reached, so both are given the verifier: a call the surface refuses reaches no entity, and a credential expiring between the two is refused by the entity.
 * - Every header of the caller's request is sent on but its connection's, its body's, what it accepts and an MCP request's routing headers (`mcp-*`); a call with no HTTP request, as through `Action.client` in process or an MCP stdio surface, sends none, so the entity refuses a protected one with `Unauthenticated`.
 * - The headers are sent with `Headers.CurrentRedactedNames` empty around the entity's client call alone, since a transport that `JSON.stringify`s them, as `@effect/platform-cloudflare`'s does, would send `authorization`, `cookie`, `set-cookie` and `x-api-key` as `<redacted>`; the caller's own logs still redact them.
 * - An input whose key answers no string is refused with `Forbidden` before any entity is reached.
 * - A poll, over HTTP or MCP's `events/poll`, is one call of the event's poll rpc; a stream, HTTP's `text/event-stream`, an RPC subscription or MCP's `events/stream`, polls the entity from the surface at each page's `nextPollMs`, a second apart at least, holding the caller's request open but no entity, so an occurrence arrives up to that interval late.
 * - What `Entity.client` fails with, `MailboxFull`, `PersistenceError` or `EntityNotAssignedToRunner`, is the call's failure, which no action declares: a surface answers it as any undeclared failure.
 * - An error the entity declares beyond the action's own and the built-in ones, its binding's `error` or its verifier's, is undeclared where the serving surface's binding does not declare it too.
 */
export const reaching = <
  const Type extends string,
  const B extends ActionRpc.Any,
>(
  entity: Entity<Type, B>
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
  const key: ErasedKeys = entity.key;

  const calls = Effect.map(entity.client, (clientFor) =>
    reachedCall(
      clientFor,
      new Set(binding.actions.filter(streams).map(({ name }) => name))
    )
  );

  const to = (contract: Action.Any | Event.Any, input: ErasedValue) => {
    const named: unknown = key[contract.name]?.(input);

    return Predicate.isString(named)
      ? Effect.succeed(named)
      : Effect.fail(
          new Action.Forbidden({
            message: `The input of ${contract.name} names no entity of ${entity.type}`,
          })
        );
  };

  const handlerOf = (
    action: Action.Any,
    call: ErasedCall
  ): WrittenHandler<unknown> => {
    const method = actionMethodOf(action, binding, (payload) =>
      call(action.name, payload)
    );

    return (input, reporting) => {
      const answer = method(
        input,
        ...(reporting === undefined ? [] : [{ onProgress: reporting.progress }])
      );

      return Stream.isStream(answer)
        ? Stream.unwrap(
            Effect.map(to(action, input), (entityId) =>
              Stream.provideService(answer, Reached, entityId)
            )
          )
        : Effect.flatMap(to(action, input), (entityId) =>
            Effect.provideService(answer, Reached, entityId)
          );
    };
  };

  const runOf = (event: Event.Any, call: ErasedCall): Run => {
    const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(event.input));
    const poll = pollOf(event, binding, (payload) => call(event.name, payload));

    const pollFrom = (
      input: ErasedValue,
      cursor: string | null,
      maxEvents?: number
    ) =>
      Effect.flatMap(to(event, input), (entityId) =>
        Effect.orDie(encode(input)).pipe(
          Effect.flatMap((json) =>
            poll({
              input: json,
              cursor,
              ...(maxEvents === undefined ? {} : { maxEvents }),
            })
          ),
          Effect.provideService(Reached, entityId)
        )
      );

    return {
      poll: (input, cursor, { maxEvents }) =>
        pollFrom(input, cursor, maxEvents),
      stream: (input, cursor) => paged((at) => pollFrom(input, at), cursor),
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
              Effect.map(calls, (call): Written =>
                binding.actions.map((action) => [
                  action,
                  handlerOf(action, call),
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
                  memoized(Effect.map(calls, (call) => runOf(event, call))),
                ] as const
            ),
            memoized(Effect.succeed<ErasedAuthorize<Event.Any>>(Event.allowAll))
          ),
        ]),
  ];
};
