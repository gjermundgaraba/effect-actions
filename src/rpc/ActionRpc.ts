import { Duration, Effect, Layer, Predicate, Schedule, Schema } from "effect";
import type { Context, Scope, Stream, Types } from "effect";
import type { HttpRouter, HttpServerRequest } from "effect/http";
import { Rpc, RpcClient, RpcGroup, RpcMiddleware, RpcServer } from "effect/rpc";
import type { RpcClientError, RpcSchema } from "effect/rpc";

import type {
  Any as Authentication,
  Descriptor,
  DescriptorOf,
  LayerIdentity,
  Matching,
  ProviderOf,
  PublicOnly,
  RemoteRequest,
  Required as RequiredAuthentication,
  Security,
  ServerBuildServices,
  ServedProvider,
  VerifierError,
} from "../authentication/provider.js";
import type * as Action from "../contract/Action.js";
import type { Call } from "../contract/call.js";
import type { Anyone } from "../contract/caller.js";
import type { Codec } from "../contract/codec.js";
import { bindingErrors, bindingOf, eventErrors } from "../contract/declared.js";
import type { Certain, ErrorsOf } from "../contract/declared.js";
import { Unauthenticated } from "../contract/errors.js";
import type { BuiltIn, BuiltIns } from "../contract/errors.js";
import type * as Event from "../contract/Event.js";
import type {
  EventBuildError,
  EventBuildServices,
  EventServedRequest,
  HoldingEvents,
  ServingEvents,
} from "../contract/feed.js";
import type {
  BuildError,
  Holding,
  Known,
  Member,
  MiddlewareOf,
  Selected,
  SelectedEvents,
  Served,
} from "../contract/implementation.js";
import { listed } from "../contract/listed.js";
import type { Only } from "../contract/listed.js";
import { reservedList, reservedNames } from "../contract/names.js";
import { PushedOf, SubscriptionOf } from "../contract/push.js";
import { provideServed, servingOf } from "../contract/serving.js";
import type { Answer, StreamOf } from "../contract/stream.js";
import type { WatchArgs } from "../contract/watch.js";
import {
  erasedCallOf,
  erasedOf,
  handlersOf,
  methodsOf,
  nativeOf,
  polledTransport,
  streamedOf,
  streamedTransport,
  verifyingNative,
} from "./erased.js";
import type { Delivery, ProgressedOf } from "./erased.js";
import { isRpcTransient } from "./watch.js";

export { AnyPage as Page } from "../contract/pages.js";

export { Poll, pollTag, Release, releaseTag } from "./erased.js";

type BindingError = Action.Errors[number];

type ErrorOf<A extends Action.Any, E extends Action.Errors, D> = Schema.Union<
  ReadonlyArray<A["error"][number] | E[number] | VerifierError<A, D> | BuiltIns>
>;

type ElementedOf<Element extends Schema.Constraint, P> = Schema.Union<
  readonly [
    Schema.TaggedStruct<"Element", { readonly value: Element }>,
    ...(P extends Codec
      ? [Schema.TaggedStruct<"Progress", { readonly value: P }>]
      : []),
  ]
>;

type RpcOf<
  A extends Action.Any,
  E extends Action.Errors,
  D,
> = A extends Action.Any
  ? A["success"] extends StreamOf<infer Element>
    ? Rpc.Rpc<
        A["name"],
        A["input"],
        RpcSchema.Stream<ElementedOf<Element, A["progress"]>, ErrorOf<A, E, D>>
      >
    : A["progress"] extends Codec
      ? Rpc.Rpc<
          A["name"],
          A["input"],
          RpcSchema.Stream<
            ReturnType<typeof ProgressedOf<A["progress"], A["success"]>>,
            ErrorOf<A, E, D>
          >
        >
      : Rpc.Rpc<A["name"], A["input"], A["success"], ErrorOf<A, E, D>>
  : never;

type EventRpcOf<
  V extends Event.Any,
  E extends Action.Errors,
  D,
> = V extends Event.Any
  ? Rpc.Rpc<
      V["name"],
      ReturnType<typeof SubscriptionOf<V>>,
      RpcSchema.Stream<
        ReturnType<typeof PushedOf<V>>,
        Schema.Union<ReadonlyArray<E[number] | VerifierError<V, D> | BuiltIns>>
      >
    >
  : never;

const authenticatedKey = "effect-actions/ActionRpc/Authenticated";

const deliveries: readonly Delivery[] = ["stream", "poll"];

type RefusalOf<E extends Action.Errors> = Schema.Union<
  ReadonlyArray<typeof Unauthenticated | E[number]>
>;

declare const authenticatedBrand: unique symbol;

interface Authenticated<I, E extends Action.Errors = Action.Errors> {
  readonly [authenticatedBrand]: typeof authenticatedBrand;
  readonly [RpcMiddleware.TypeId]: {
    readonly provides: I;
    readonly requires: never;
    readonly error: RefusalOf<E>;
    readonly clientError: never;
  };
}

type AuthenticatedOf<D> =
  D extends Descriptor<infer I, unknown, Security, string, infer E>
    ? RpcMiddleware.ServiceClass<
        Authenticated<I, E>,
        typeof authenticatedKey,
        I,
        RefusalOf<E>,
        never,
        never,
        false
      >
    : never;

type NativeOf<N extends Rpc.Any, D> = [D] extends [Authentication]
  ? Rpc.AddMiddleware<N, AuthenticatedOf<D>>
  : N;

/**
 * An RPC binding: actions, event types, the errors every rpc declares, the descriptor
 * authenticating its protected ones, and the native rpcs it serves beside them. Plain data, so a
 * copy of it, or one made by another installed copy of this package, serves the same; `layer`
 * serves it and `client` calls it.
 */
export interface Binding<
  Actions extends readonly Action.Any[],
  E extends Action.Errors = [],
  D extends Authentication | undefined = undefined,
  Events extends readonly Event.Any[] = readonly [],
  N extends Rpc.Any = never,
> {
  /** The descriptor authenticating its protected actions, or `undefined` when it names none. */
  readonly authentication: D;
  /** The exact actions bound to this binding. */
  readonly actions: Actions;
  /** The exact event types bound to this binding, each a stream rpc named after it. */
  readonly events: Events;
  /** The errors every rpc declares besides its action's own, as a list. */
  readonly error: E;
  /**
   * The native rpcs `make`'s `rpcs` gave, as served: under an `authentication`, each runs
   * behind the middleware authenticating it, which provides its handler the identity. A host
   * implements them with `rpcs.toLayer`.
   */
  readonly rpcs: RpcGroup.RpcGroup<NativeOf<N, D>>;
  /**
   * The typed native group of one rpc per action, named after it, one stream rpc per event
   * type, taking `{ input, cursor }`, `cursor: null` reading from now, and `rpcs`:
   * `RpcClient.make(Rpc.group)` is a native client of them.
   *
   * **Gotchas**
   *
   * - It holds no event's `<event>/poll` or `<event>/release`, which `layer` serves beside its stream rpc: a native client of it watches by stream alone; poll through `client` with `delivery: "poll"`.
   * - `layer` hands the protocol an action's and an event type's values as their JSON, the native `rpcs`' as they are: under a codec other than a JSON serialization's, such as schema-binary's or a protocol passing values, `RpcClient.make(Rpc.group)` decodes an action's answer or an event's occurrence by its own schema and fails; call actions and watch events through `client`, which hands them over as JSON too.
   */
  readonly group: RpcGroup.RpcGroup<
    | RpcOf<Actions[number], E, D>
    | EventRpcOf<Events[number], E, D>
    | NativeOf<N, D>
  >;
}

/**
 * Any RPC binding. Its groups are any native groups here, since native groups are invariant in
 * their rpcs; `actions` carries the types.
 */
export interface Any {
  readonly authentication?: Authentication | undefined;
  readonly actions: readonly Action.Any[];
  readonly events: readonly Event.Any[];
  readonly error: Action.Errors;
  readonly rpcs: RpcGroup.Any;
  readonly group: RpcGroup.Any;
}

/** Contract-level configuration shared by servers and clients. */
export interface Options<E extends Action.Errors = Action.Errors> {
  /**
   * What the layer's `middleware` fails with, which every rpc declares so clients decode it:
   * one schema, or a list.
   */
  readonly error?: E | E[number];
  /**
   * `Authentication.make(...)` of the protected actions' identity, which authenticates each of
   * their messages: required when the binding holds a protected action, and of its identity.
   */
  readonly authentication?: Authentication;
  /**
   * Native rpcs the binding serves beside its actions and event types, with their own schemas
   * and handlers: `RpcGroup.make(Upload)`. Under an `authentication`, each of their messages
   * authenticates as a protected action's does: its handler reads the identity, and a refusal
   * fails the call with `Unauthenticated`.
   *
   * **Gotchas**
   *
   * - `layer` requires their handlers, which the host provides from the binding's own `rpcs`: `Rpc.rpcs.toLayer(handlers)`, whose types then leave the identity unowed.
   * - A native rpc runs no implementation's `authorize`: its handler authorizes the identity itself, as an action's `authorize` would, or every authenticated caller is served.
   * - The layer's `middleware` runs on actions and event types alone: a native rpc runs the native middleware its group adds, inside its authentication.
   * - Native middleware added to the binding's `rpcs` after `make` runs outside the authentication, before the identity exists; added to the group given here, inside it.
   * - `layer` refuses a protected binding holding a native rpc without its authentication, such as one added with `rpcs.add` after `make`: add rpcs to the group given here.
   * - A native rpc named after an action, an event type, an event's `<event>/poll` or `<event>/release`, or a name the client keeps, `then` or `watch`, its method of events, is refused as the binding is made.
   */
  readonly rpcs?: RpcGroup.Any;
}

type RpcsOf<O> = O extends { readonly rpcs: infer G }
  ? RpcGroup.Rpcs<G>
  : never;

const authenticatedOf = (authentication: Authentication) =>
  RpcMiddleware.Service<Authenticated<unknown>, { provides: unknown }>()(
    authenticatedKey,
    {
      error: Schema.Union([Unauthenticated, ...authentication.error]),
    }
  );

const authenticatedIn = (rpc: Rpc.AnyWithProps) =>
  [...rpc.middlewares].find(({ key }) => key === authenticatedKey);

/**
 * Bind actions once, for servers and clients alike, each as an rpc named after it, taking
 * its action's input and answering its success, and event types, each a stream rpc named after
 * it, taking `{ input, cursor }`, which `layer` serves by poll too, as its `pollTag` and `releaseTag` rpcs. Every rpc declares its action's errors, the binding's `error`,
 * and the built-in `InvalidInput`, `Unauthenticated` and `Forbidden`, so clients decode each as
 * a typed failure; a protected one also declares what its descriptor's verifier fails with.
 * `rpcs` adds native ones beside them. Browser-safe, as an HTTP binding is.
 * Guide: `docs/ActionRpc.md` in this package; in an application: `examples/live-rpc/`.
 *
 * **Gotchas**
 *
 * - An action, an event type and a native rpc of one name throw when `make` is called: they would share a client's method.
 * - An authentication reading an API key `in: "query"` throws when `make` is called: an rpc carries headers alone, on every protocol and in an entity's envelope.
 * - An action declaring `progress` is a stream rpc taking its input, streaming `{ _tag: "Progress", value }` for each value its handler reports, then one `{ _tag: "Final", value }` holding its answer: the native client's method of it returns a `Stream`.
 * - An action answering a stream, `Action.Stream`, is a stream rpc taking its input, streaming `{ _tag: "Element", value }` for each element, beside `{ _tag: "Progress", value }` for each value where it declares `progress`; `client`'s method returns a `Stream` of the elements.
 */
export function make<
  const Contracts extends ReadonlyArray<
    (Action.Any | Event.Any) & { readonly caller: typeof Anyone }
  >,
>(
  contracts: Contracts
): Binding<
  Only<Contracts, Action.Any>,
  [],
  undefined,
  Only<Contracts, Event.Any>
>;
export function make<
  const Contracts extends ReadonlyArray<Action.Any | Event.Any>,
  const O extends Options = {},
>(
  contracts: Contracts,
  options: O &
    RequiredAuthentication<Contracts[number]> &
    Matching<Contracts[number], NoInfer<DescriptorOf<O>>> &
    NoInfer<Known<O, Options>>
): Binding<
  Only<Contracts, Action.Any>,
  ErrorsOf<O>,
  DescriptorOf<O>,
  Only<Contracts, Event.Any>,
  RpcsOf<O>
>;
export function make<
  const Contracts extends ReadonlyArray<Action.Any | Event.Any>,
>(
  contracts: Contracts & PublicOnly<Contracts>
): Binding<
  Only<Contracts, Action.Any>,
  [],
  undefined,
  Only<Contracts, Event.Any>
>;
export function make(
  contracts: ReadonlyArray<Action.Any | Event.Any>,
  options: Options = {}
): Any {
  const { actions, events } = listed(contracts);
  const bound = bindingOf("ActionRpc binding", actions, events, options);
  const security = bound.authentication?.security;

  if (Predicate.isTagged(security, "ApiKey") && security.in === "query") {
    throw new Error(
      `ActionRpc binding: its authentication reads its API key ${security.key} from the query, which no rpc carries (read it from a header: HttpApiSecurity.apiKey({ in: "header", key }))`
    );
  }

  const rpcOf = (action: Action.Any) => {
    const streamed = streamedOf(action);

    return Rpc.make(action.name, {
      payload: action.input,
      success: streamed ?? action.success,
      error: Schema.Union(bindingErrors(action, bound)),
      stream: streamed !== undefined,
    });
  };

  const given =
    options.rpcs === undefined ? RpcGroup.make() : nativeOf(options.rpcs);

  const served = erasedOf(actions, events, deliveries).requests;

  for (const tag of given.requests.keys()) {
    if (reservedNames.includes(tag) || served.has(tag)) {
      throw new Error(
        `ActionRpc binding: the rpc "${tag}" of rpcs is named after an action, an event type, an event's poll or release, or a name the client keeps, ${reservedList} (rename it)`
      );
    }
  }

  const rpcs =
    bound.authentication === undefined
      ? given
      : given.middleware(authenticatedOf(bound.authentication));

  const group = RpcGroup.make(
    ...actions.map(rpcOf),
    ...events.map((event) =>
      Rpc.make(event.name, {
        payload: SubscriptionOf(event),
        success: PushedOf(event),
        error: Schema.Union(eventErrors(event, bound)),
        stream: true,
      })
    )
  ).merge(rpcs);

  return { actions, events, ...bound, rpcs, group };
}

type Middleware = readonly RpcMiddleware.AnyService[];

type IdOf<K> =
  K extends Context.Key<infer I extends RpcMiddleware.AnyId, unknown>
    ? I
    : never;

type Through<M extends Middleware, R> = number extends M["length"]
  ? R | RpcMiddleware.Requires<IdOf<M[number]>>
  : M extends readonly [infer K, ...infer Rest extends Middleware]
    ? Through<
        Rest,
        true extends Types.IsUnion<IdOf<K>>
          ? R | RpcMiddleware.Requires<IdOf<K>>
          : RpcMiddleware.ApplyServices<IdOf<K>, R>
      >
    : R;

type ForClient<K> = K extends { readonly requiredForClient: infer F }
  ? true extends F
    ? K
    : never
  : never;

type ServerOnly<M extends Middleware, E extends Action.Errors> = [
  | Exclude<
      RpcMiddleware.Error<IdOf<M[number]>>,
      Extract<Certain<E>, BindingError>["Type"] | BuiltIn
    >
  | ForClient<M[number]>,
] extends [never]
  ? unknown
  : {
      readonly "Layer middleware fails only with the binding's errors and needs no client": never;
    };

type LayerRequest<
  App,
  A extends Action.Any,
  E extends Event.Any,
  M extends Middleware,
> = Exclude<
  Through<M, RemoteRequest<App, A> | EventServedRequest<App, E>>,
  | HttpServerRequest.HttpServerRequest
  | HttpServerRequest.ParsedSearchParams
  | LayerIdentity<App, A, E>
>;

type RpcLayer<
  B extends Any,
  Apps extends Served,
  M extends Middleware,
  A extends Action.Any = B["actions"][number],
  E extends Event.Any = B["events"][number],
> = Layer.Layer<
  never,
  | BuildError<Holding<Member<Apps>, A>, A>
  | EventBuildError<HoldingEvents<Member<Apps>, E>, E>,
  | ServerBuildServices<Holding<Member<Apps>, A>, A>
  | EventBuildServices<HoldingEvents<Member<Apps>, E>, E>
  | RpcServer.Protocol
  | HttpRouter.Request.From<"Requires", LayerRequest<Member<Apps>, A, E, M>>
  | ServedProvider<
      Member<Apps>,
      A,
      B extends { readonly authentication: infer D } ? D : never,
      ServingEvents<Member<Apps>, E>
    >
  | IdOf<M[number]>
  | NativeServer<
      RpcGroup.Rpcs<B["rpcs"]>,
      B extends { readonly authentication: infer D } ? D : never
    >
>;

type NativeServer<N extends Rpc.Any, D> = [N] extends [never]
  ? never
  :
      | Rpc.ToHandler<N>
      | Exclude<Rpc.Middleware<N>, Authenticated<unknown>>
      | Rpc.ServicesServer<N>
      | ProviderOf<D>;

/** `ActionRpc.layer`'s options. */
export interface LayerOptions<
  M extends Middleware = [],
  C extends Action.Any | Event.Any = never,
> {
  /**
   * The actions and event types it serves, among the binding's the implementations hold:
   * `[GetUser, UserRenamed]`, exactly those. Defaults to every one of them.
   *
   * **Gotchas**
   *
   * - A list naming actions alone serves no event type: a client's watch fails with `Event.SubscriptionError`, reason `NotServed`, until the event types are listed beside them.
   */
  readonly actions?: readonly C[] | undefined;
  /**
   * Native rpc middleware every served rpc runs on each message, the first innermost: inside
   * the authentication of a protected rpc, so none provides what a verifier reads, and outside
   * its decoding, so it also sees input that does not decode. Server-only: the binding's group,
   * which clients use, carries none.
   *
   * **Gotchas**
   *
   * - A middleware requiring the identity leaves it owed on a layer serving a public action or event type: bind the protected ones apart, or read the identity with `Effect.serviceOption`, which a public rpc's call lacks.
   * - A middleware provides a service only to those listed before it and the handlers, and only in a list written in place as a tuple: listed earlier, or in an array-typed list, it leaves the service owed.
   * - Router middleware around the layer runs once per WebSocket, at its upgrade, so its value holds for the whole connection: what differs per message needs a listed middleware.
   * - On an event's stream rpc, a middleware and the authentication run once, around the subscription's admission, not its stream: one timing the call or releasing something as it ends sees it end as the stream starts, and never sees a later refusal; what it provides lasts the stream.
   * - On the stream rpc of an action declaring `progress` or answering a stream they run around its start alike, before its handler runs: one timing it sees it end before the handler does, and never sees its failure; what it provides lasts the handler.
   */
  readonly middleware?: M;
}

/**
 * Serve the binding's actions and event types among `implementations` with Effect's own
 * `RpcServer`, or those its `actions` lists, as `ActionHttp.layer` selects them, under the
 * protocol and serialization the host provides. Each message of a protected rpc authenticates
 * from its own headers with the binding's descriptor; then the listed `middleware` runs, the
 * input decodes, and the implementation's `authorize` and the handler run, as on every surface.
 * The layer fails as the builders do and needs at startup what they need; per request it owes,
 * as router request markers, what the authorizers and handlers read until its `middleware`
 * provides it, or, over a router-mounted protocol, the route's request context.
 * A protected action's identity comes from its authentication alone.
 *
 * **Gotchas**
 *
 * - Provide the protocol to this layer, inside what `HttpRouter.serve` serves: `RpcServer.layerProtocolWebsocket` and `layerProtocolHttp` add their route to that router, and provided around `HttpRouter.serve` they leave `HttpRouter` owed.
 * - An rpc the layer does not serve ends its call with `Unknown request tag`, as does every rpc of a second `ActionRpc.layer` given the same protocol, which never receives a message: serve a protocol's rpcs from one layer, or give the second a protocol on another path.
 * - A declared error, or `InvalidInput` for input that does not decode, is the call's typed failure; a refusal is answered as `Action.Unauthenticated` and `Action.Forbidden` say; the socket stays open, so a token may expire under it and a client handles `Unauthenticated` itself.
 * - A defect, an undeclared failure, a middleware that throws, or a success or an error that does not encode ends that call with an `Error` whose message is `Internal server error`, its cause logged and reported to the call's `ErrorReporter`s; the connection's other calls go on.
 * - An `ErrorReporter` is given only what ends a call with `Internal server error`, never a declared failure, a refusal or `InvalidInput`, unlike `ActionHttp.layer`'s `Info`: an alert counting declared failures counts none from rpcs.
 * - Over a protocol with no router, such as `RpcServer.layerProtocolSocketServer` or `layerProtocolStdio`, there is no route: a provider publishing a `protectedResource` leaves `HttpRouter` owed; the request a handler or a verifier reads is, on every protocol, one holding the message's headers, at `/`, with no query or body.
 * - An event's stream rpc takes `{ input, cursor }`, a `cursor` omitted or `null` reading from now, and streams `Checked`, `Occurrence`, `Gap` and `Failed`, a `Checked` every 30 seconds; over `RpcServer.layerProtocolHttp` serialize with `RpcSerialization.layerNdjson`: under `layerJson` a response is sent once its streams end, so a watch never answers.
 * - Beside it, an event's `<event>/poll` answers a `Page` and its `<event>/release` frees a watch's subscription hook, as an `ActionEntity`'s do, so a `client` under either `delivery` watches the layer.
 * - A subscription refused when it starts or later ends its stream rpc with the refusal as the typed failure; a source's failure no refusal explains is logged and reported once, sent as a bare `Failed`, and read again from where it reached after 5 seconds.
 * - A stream is read only as fast as its client reads it: a slow reader of a log source falls behind its log, and receives a `Gap`.
 * - An action declaring `progress` streams it to every call, a client's call without `onProgress` too, its values handed on one at a time, so a slow reader drops the oldest; under `RpcSerialization.layerJson` over HTTP they arrive with the answer, at the end.
 * - A failure after an action's progress or its first element ends its stream rpc as it ends any call: a declared failure as the typed failure, a defect as `Internal server error`.
 * - The binding's native `rpcs` are served on the same protocol with their own schemas, every one, whatever `actions` lists, and their handlers are owed until provided: `Rpc.rpcs.toLayer(handlers)`; a native rpc's defect or undeclared failure is answered as Effect's server answers it, never `Internal server error`, and only its verifier's defect is.
 */
export function layer<const B extends Any, const Apps extends Served>(
  binding: B,
  implementations: Apps
): RpcLayer<B, Apps, []>;
export function layer<
  const B extends Any,
  const Apps extends Served,
  const O extends LayerOptions<
    Middleware,
    B["actions"][number] | B["events"][number]
  >,
>(
  binding: B,
  implementations: Apps,
  options: O &
    ServerOnly<MiddlewareOf<O, Middleware>, B["error"]> &
    NoInfer<Known<O, LayerOptions<Middleware>>>
): RpcLayer<
  B,
  Apps,
  MiddlewareOf<O, Middleware>,
  Selected<O, B["actions"][number]>,
  SelectedEvents<O, B["events"][number]>
>;
export function layer(
  binding: Any,
  served: Served,
  options: LayerOptions<Middleware> = {}
): Layer.Layer<never, unknown, unknown> {
  const selected = servingOf("RPC binding", binding, served, options);
  const { apps, actions, events, eventTypes } = selected;

  const middleware = options.middleware ?? [];

  const jsonGroup = erasedOf(actions, eventTypes, deliveries);

  const natives = [...nativeOf(binding.rpcs).requests.values()];

  const authentication =
    natives.length === 0 ? selected.authentication : binding.authentication;

  const handlers = Layer.unwrap(
    Effect.gen(function* () {
      const unauthenticated =
        authentication === undefined
          ? undefined
          : natives.find((rpc) => authenticatedIn(rpc) === undefined);

      if (unauthenticated !== undefined) {
        return yield* Effect.die(
          new Error(
            `ActionRpc.layer: the native rpc ${unauthenticated._tag} of a protected binding runs without its authentication: add it to the group ActionRpc.make is given as its rpcs, not to the binding's rpcs after`
          )
        );
      }

      const { handlers: byName, authenticating } = yield* handlersOf(binding, {
        apps,
        events,
        authentication,
        middleware,
        server: "ActionRpc.layer",
      });

      const servedActions = jsonGroup.toLayer(byName);

      const authenticated = natives
        .map(authenticatedIn)
        .find(Predicate.isNotUndefined);

      if (authenticated === undefined || authenticating === undefined) {
        return servedActions;
      }

      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const authenticate = authenticating(
        verifyingNative
      ) as RpcMiddleware.RpcMiddleware<unknown, unknown, never>;

      return Layer.merge(
        servedActions,
        Layer.succeed(authenticated)(authenticate)
      );
    })
  ).pipe(provideServed(selected.apps, selected.events));

  return RpcServer.layer(jsonGroup.merge(binding.rpcs), {
    disableFatalDefects: true,
  }).pipe(Layer.provide(handlers));
}

/**
 * What one call of an action `A` fails with, beside the binding's errors `E`: its declared and
 * built-in errors, and Effect's own `RpcClientError` when the server could not be reached. An
 * answer that does not decode is a defect, as the native client makes it.
 */
export type MethodError<A extends Action.Any, E extends BindingError = never> =
  | A["error"][number]["Type"]
  | E["Type"]
  | BuiltIns["Type"]
  | RpcClientError.RpcClientError;

type Method<A extends Action.Any, E extends BindingError> = Call<
  A,
  Answer<A["success"], MethodError<A, E>, never>
>;

/**
 * What a watch of `W` over the binding `B` may fail with: a refusal, when it starts or later,
 * `InvalidInput`, the binding's errors, an `Event.SubscriptionError` (`Unsupported` for a
 * `mode` other than the client's `delivery`, `NotServed` for an event the server does not serve), or
 * Effect's own `RpcClientError` that no reconnect outlasts. An element that does not decode is a defect, as for a call.
 */
export type WatchError<W extends Event.Any, B extends Any> =
  | Event.SubscriptionError
  | BuiltIns["Type"]
  | B["error"][number]["Type"]
  | VerifierError<W, B["authentication"]>["Type"]
  | RpcClientError.RpcClientError;

type Watching<B extends Any> = [B["events"][number]] extends [never]
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
 * options)` streams one; each native rpc of its `rpcs` is the native client's method.
 */
export type Client<B extends Any> = {
  readonly [A in B["actions"][number] as A["name"]]: Method<
    A,
    B["error"][number] | VerifierError<A, B["authentication"]>
  >;
} & Watching<B> &
  RpcClient.RpcClient<RpcGroup.Rpcs<B["rpcs"]>, RpcClientError.RpcClientError>;

/**
 * `client`'s options: the native `RpcClient.make` options, `spanPrefix`, `spanAttributes`,
 * `generateRequestId` and `disableTracing`, and `delivery`. `flatten` changes the client's
 * shape, which the method types cannot follow.
 */
export interface ClientOptions extends Omit<
  NonNullable<Parameters<typeof RpcClient.make>[1]>,
  "flatten"
> {
  /**
   * How `watch` follows an event: `"stream"`, the default, holds its stream rpc open; `"poll"`
   * calls its `<event>/poll` for each page and its `<event>/release` as the watch ends.
   * `ActionRpc.layer` serves both, an `ActionEntity` and the Cloudflare package's socket host the
   * polls alone, the rpcs `ActionEntity.bindingRpcs(entity)` holds.
   *
   * **Gotchas**
   *
   * - Under `"poll"`, a poll unanswered for `pollResentAfter` is sent again from the same cursor, the first interrupted, so a server that holds a poll until something changes, as the Cloudflare package's socket host does, reads it again at least that often.
   */
  readonly delivery?: "stream" | "poll" | undefined;
}

/**
 * How long a watch under `delivery: "poll"` waits for a poll's answer, 4 minutes, before it
 * sends the poll again from the same cursor and interrupts the first.
 */
export const pollResentAfter = Duration.minutes(4);

/**
 * Effect's native `RpcClient` for a binding, one method per action taking the action's input
 * directly: `client.greet({ name })`, as `ActionHttp.client`'s, the argument omitted when `{}`
 * is a valid input, each call failing with its `MethodError`. Requires the native client
 * `Protocol` and a `Scope`, as `RpcClient.make` does; headers set with `RpcClient.withHeaders`
 * around a call go with its message, and the binding's native `rpcs` are its methods too. The
 * native client stays available under a JSON serialization: `RpcClient.make(Rpc.group)`.
 *
 * **Gotchas**
 *
 * - It drops undeclared input fields as it encodes, and fails with `InvalidInput`, sending nothing, for an input that does not encode.
 * - A browser WebSocket cannot set an `Authorization` header on its upgrade, so under Bearer a protected call without its own token fails with `Unauthenticated`, `A bearer token is required.`: send the token on each call with `RpcClient.withHeaders`.
 * - The socket belongs to the Layer providing the protocol, not to the `Scope` around the client: provided around one call, it opens a socket for that call alone.
 * - Under the default `delivery`, `watch(event, input, options)` holds the event's stream rpc open, as `Action.client`'s does; `mode: "poll"` fails with `Event.SubscriptionError`, reason `Unsupported`: poll with `delivery: "poll"`; under either, a watch of an event the server does not serve fails with `Event.SubscriptionError`, reason `NotServed`, as over HTTP.
 * - A watch reconnects after the protocol's socket or HTTP transport fails, a response ends before its stream does, as a server's restart ends it, a status a server sends while it recovers, or, over Effect's HTTP protocol, 60 seconds without an element, a socket's own pings telling a dead one, a second later and doubling to 30 seconds, each reconnect logged as a warning; a declared error, a refusal included, or a socket's close with an application's code, 4000 to 4999, ends it.
 * - A native rpc of the binding's `rpcs` is the native client's method: a stream rpc's is a `Stream`, its headers given as its options' `headers`, since `RpcClient.withHeaders` wraps an Effect.
 */
export function client<const B extends Any>(
  binding: B,
  options?: ClientOptions
): Effect.Effect<
  Client<B>,
  never,
  | RpcClient.Protocol
  | Scope.Scope
  | Rpc.MiddlewareClient<RpcGroup.Rpcs<B["rpcs"]>>
>;
export function client(
  binding: Any,
  { delivery = "stream", ...options }: ClientOptions = {}
): Effect.Effect<object, never, RpcClient.Protocol | Scope.Scope> {
  return Effect.map(
    Effect.all([
      RpcClient.make(
        erasedOf(binding.actions, binding.events, [delivery]).merge(
          nativeOf(binding.rpcs)
        ),
        { ...options, flatten: true }
      ),
      Effect.map(
        Effect.service(RpcClient.Protocol),
        ({ supportsAck }) => !supportsAck
      ),
    ]),
    ([call, silenceEnds]) =>
      methodsOf(
        binding,
        erasedCallOf(call),
        delivery === "stream"
          ? streamedTransport(silenceEnds)
          : polledTransport(isRpcTransient, pollResentAfter)
      )
  );
}

/**
 * What `reconnectUntil`'s schedule reads of each failure to connect: the `reason` of the
 * `Socket.SocketError` Effect's socket protocol retries after.
 */
export interface ReconnectReason {
  readonly reason: unknown;
}

/**
 * A socket client's `retryPolicy`, for `RpcClient.layerProtocolSocket`, that stops connecting
 * again once the server closes the socket with one of `codes`, such as a refusal of its upgrade:
 * until then it is Effect's own default, `Schedule.min([Schedule.exponential(500, 1.5),
 * Schedule.spaced(5000)])`, which Effect does not export. A page refused with its code stops, its
 * calls and streams failing with an `RpcClientError` whose `reason` is that `SocketCloseError`,
 * its `code` the one it closed with.
 *
 * **Gotchas**
 *
 * - A client without it connects again after a refusal as after any close, every five seconds for good.
 * - Any other socket error, a drop included, is retried as Effect's default retries it.
 */
export const reconnectUntil = (...codes: readonly number[]) =>
  Schedule.min([Schedule.exponential(500, 1.5), Schedule.spaced(5000)]).pipe(
    Schedule.setInputType<ReconnectReason>(),
    Schedule.while(
      ({ input: { reason } }) =>
        !(
          Predicate.isTagged(reason, "SocketCloseError") &&
          Predicate.hasProperty(reason, "code") &&
          codes.some((code) => code === reason.code)
        )
    )
  );
