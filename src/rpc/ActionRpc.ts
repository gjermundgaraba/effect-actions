import {
  Cause,
  Effect,
  ErrorReporter,
  Layer,
  Match,
  Option,
  Predicate,
  Queue,
  Result,
  Schedule,
  Schema,
  Stream,
  SchemaTransformation,
} from "effect";
import type { Context, Scope, Types } from "effect";
import { HttpClientRequest, HttpServerRequest } from "effect/http";
import type { Headers, HttpRouter } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  Rpc,
  RpcClient,
  RpcGroup,
  RpcMiddleware,
  RpcSchema,
  RpcServer,
} from "effect/rpc";
import type { RpcClientError, RpcMessage } from "effect/rpc";

import { providerOf } from "../authentication/provider.js";
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
import {
  checked,
  checkedStream,
  decodeInput,
  inputParseOptions,
  sendingJson,
  watchInput,
} from "../contract/call.js";
import type {
  Call,
  ErasedMethod,
  ErasedStreamMethod,
} from "../contract/call.js";
import { Anyone } from "../contract/caller.js";
import type { Codec } from "../contract/codec.js";
import { bindingErrors, bindingOf, eventErrors } from "../contract/declared.js";
import type { Certain, ErrorsOf } from "../contract/declared.js";
import { InvalidInput, Unauthenticated } from "../contract/errors.js";
import type { BuiltIn, BuiltIns } from "../contract/errors.js";
import type * as Event from "../contract/Event.js";
import { acquireFeeds } from "../contract/feed.js";
import type {
  EventBuildError,
  EventBuildServices,
  EventServedRequest,
  Feed,
  HoldingEvents,
  ServingEvents,
} from "../contract/feed.js";
import { acquire, elementsOf } from "../contract/implementation.js";
import type {
  BuildError,
  ErasedHandler,
  ErasedValue,
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
import { answerFrom, elementsFrom, Progressed } from "../contract/progress.js";
import type { Reporting } from "../contract/progress.js";
import {
  PushedOf,
  queuedPush,
  Subscription,
  SubscriptionOf,
} from "../contract/push.js";
import { concealed } from "../contract/reported.js";
import { provideServed, servingOf } from "../contract/serving.js";
import { elementOf } from "../contract/stream.js";
import type { Answer, StreamOf } from "../contract/stream.js";
import { watching } from "../contract/watch.js";
import type { WatchArgs } from "../contract/watch.js";
import { transportOf } from "./watch.js";
import type { StreamMethod } from "./watch.js";

type BindingError = Action.Errors[number];

type ErrorOf<A extends Action.Any, E extends Action.Errors, D> = Schema.Union<
  ReadonlyArray<A["error"][number] | E[number] | VerifierError<A, D> | BuiltIns>
>;

/**
 * What the stream rpc of an action declaring `progress` sends: a `Progress` for each value its
 * handler reports, then a `Final` with its answer.
 */
const ProgressedOf = <P extends Codec, S extends Codec>(
  progress: P,
  success: S
) =>
  Schema.Union([
    Schema.TaggedStruct("Progress", { value: progress }),
    Schema.TaggedStruct("Final", { value: success }),
  ]);

/**
 * What the stream rpc of an action answering a stream sends: an `Element` for each element, and a
 * `Progress` for each value its handler reports where it declares `progress`.
 */
type ElementedOf<Element extends Schema.Constraint, P> = Schema.Union<
  readonly [
    Schema.TaggedStruct<"Element", { readonly value: Element }>,
    ...(P extends Codec
      ? [Schema.TaggedStruct<"Progress", { readonly value: P }>]
      : []),
  ]
>;

const elementedOf = (element: Codec, progress: Codec | undefined) =>
  Schema.Union([
    Schema.TaggedStruct("Element", { value: element }),
    ...(progress === undefined
      ? []
      : [Schema.TaggedStruct("Progress", { value: progress })]),
  ]);

/** Whether `action`'s rpc is a stream rpc: it answers a stream, or declares `progress`. */
const streams = (action: Action.Any) =>
  action.progress !== undefined || elementOf(action.success) !== undefined;

/** What `action`'s rpc answers, or each element it streams where it is a stream rpc. */
const sentOf = (action: Action.Any): Codec => {
  const element = elementOf(action.success);

  if (element !== undefined) {
    return elementedOf(element, action.progress);
  }

  return action.progress === undefined
    ? action.success
    : ProgressedOf(action.progress, action.success);
};

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

type RefusalOf<E extends Action.Errors> = Schema.Union<
  ReadonlyArray<typeof Unauthenticated | E[number]>
>;

declare const authenticatedBrand: unique symbol;

/**
 * The middleware authenticating a binding's native rpcs, as Effect's server reads it: what it
 * provides their handlers, and what it fails with.
 */
interface Authenticated<I, E extends Action.Errors = Action.Errors> {
  // Why: the brand is this middleware's alone, so `NativeServer` excluding it from a layer's
  // requirements never excludes a host's middleware of the same shape, which stays owed.
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
   * The native group of one rpc per action, named after it, one stream rpc per event type,
   * taking `{ input, cursor }`, `cursor: null` reading from now, and `rpcs`, as clients see it:
   * `RpcClient.make(Rpc.group)` is the native client.
   *
   * **Gotchas**
   *
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
   * - A native rpc named after an action, an event type or a name the client keeps, `then` or `watch`, its method of events, is refused as the binding is made.
   */
  readonly rpcs?: RpcGroup.Any;
}

const nativeOf = (group: RpcGroup.Any) =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Native group boundary: every native group is a `RpcGroup` of native rpcs, each carrying its schemas and middleware; only its invariant static rpcs are dropped.
  group as RpcGroup.RpcGroup<Rpc.AnyWithProps>;

type RpcsOf<O> = O extends { readonly rpcs: infer G }
  ? RpcGroup.Rpcs<G>
  : never;

// Why: a native rpc's refusal is its own call's typed failure, as an action's is: the
// middleware's error joins the rpc's in the exit both sides encode, so its client decodes
// `Unauthenticated` and the verifier's errors without declaring them. `make` builds it once per
// binding, and `layer` provides its implementation under the one its native rpcs carry.
const authenticatedOf = (authentication: Authentication) =>
  RpcMiddleware.Service<Authenticated<unknown>, { provides: unknown }>()(
    authenticatedKey,
    {
      error: Schema.Union([Unauthenticated, ...authentication.error]),
    }
  );

/** The middleware authenticating `rpc`, wherever among its middleware it runs. */
const authenticatedIn = (rpc: Rpc.AnyWithProps) =>
  [...rpc.middlewares].find(({ key }) => key === authenticatedKey);

// Why: The same three overloads as `ActionHttp.make`, for the reasons stated there.
/**
 * Bind actions once, for servers and clients alike, each as an rpc named after it, taking
 * its action's input and answering its success, and event types, each a stream rpc named after
 * it, taking `{ input, cursor }`. Every rpc declares its action's errors, the binding's `error`,
 * and the built-in `InvalidInput`, `Unauthenticated` and `Forbidden`, so clients decode each as
 * a typed failure; a protected one also declares what its descriptor's verifier fails with.
 * `rpcs` adds native ones beside them. Browser-safe, as an HTTP binding is.
 * Guide: `docs/ActionRpc.md` in this package; in an application: `examples/live-rpc/`.
 *
 * **Gotchas**
 *
 * - An action, an event type and a native rpc of one name throw when `make` is called: they would share a client's method.
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

  const rpcOf = (action: Action.Any) =>
    Rpc.make(action.name, {
      payload: action.input,
      success: sentOf(action),
      error: Schema.Union(bindingErrors(action, bound)),
      stream: streams(action),
    });

  const given =
    options.rpcs === undefined ? RpcGroup.make() : nativeOf(options.rpcs);

  for (const tag of given.requests.keys()) {
    if (
      reservedNames.includes(tag) ||
      contracts.some((contract) => contract.name === tag)
    ) {
      throw new Error(
        `ActionRpc binding: the rpc "${tag}" of rpcs is named after an action, an event type or a name the client keeps, ${reservedList} (rename it)`
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

// Why: every call of an action or an event type runs with the request `withRequestOf` makes of
// its message's headers, on every protocol, so the request and its search params are never owed;
// a route's `RouteContext` exists only over a router-mounted protocol, where `HttpRouter.serve`
// provides it, so unlike `ActionHttp`'s, this keeps it owed, and a handler reading one leaves it
// owed on stdio, a socket or a worker.
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

// Why: the native rpcs' handlers are the host's, provided as Effect's own `toLayer` provides
// them, so a layer without them is refused where the server is launched; the middleware
// authenticating them is the layer's own, never owed.
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

// Why: a message carries headers alone, and no transport gives a call its request: a server
// on a socket runs in a fiber of its own, and a hibernated object's message arrives with none. A
// verifier is typed as reading the request, as over HTTP, so it reads one holding the message's
// headers, which a socket's upgrade headers precede, where the credential is decoded from too;
// every call runs with it, so a placed action sends those headers on.
const withRequestOf =
  (headers: Headers.Headers) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromClientRequest(
          HttpClientRequest.get("/", { headers })
        )
      ),
      Effect.provideService(HttpServerRequest.ParsedSearchParams, {})
    );

type CallOptions = Parameters<
  RpcMiddleware.RpcMiddleware<never, never, never>
>[1];

type Step = (
  effect: Effect.Effect<unknown, unknown, unknown>,
  options: CallOptions
) => Effect.Effect<unknown, unknown, unknown>;

// Why: The steps run here, each suspended, and none as native rpc middleware. Effect applies
// native middleware as it sets a call up, outside any Effect, so one that throws fails the whole
// connection; suspended, a throw is its own call's defect.
/** `call` inside `steps`, the first innermost, each given the call's options. */
const throughSteps = (
  steps: readonly Step[],
  call: Effect.Effect<unknown, unknown, unknown>,
  options: CallOptions
) => {
  let wrapped = call;

  for (const step of steps) {
    const inner = wrapped;

    wrapped = Effect.suspend(() => step(inner, options));
  }

  return wrapped;
};

/**
 * The step authenticating a call with `authentication`'s provider: the identity its verification
 * answers is provided to the call, the verification run as `verifying` runs it.
 */
const authenticatingOf = (authentication: Authentication) =>
  Effect.map(providerOf(authentication), (provider) => {
    const verify = Effect.flatMap(
      HttpApiBuilder.securityDecode(authentication.security),
      provider.authenticate
    );

    return (
      verifying: (verify: Verification, options: CallOptions) => Verification
    ): Step =>
      (effect, options) =>
        Effect.flatMap(verifying(verify, options), (actor) =>
          Effect.provideService(effect, authentication.identity, actor)
        );
  });

type Verification = Effect.Effect<unknown, unknown, unknown>;

// Why: A declared failure is the caller's answer, which no error reporter is given. The mark
// that says so is on this wrapper, which both ends' groups carry as the JSON it holds, and
// never on the JSON: a mark on the failure touches a value the handler made, and a primitive
// takes none. It prints as its JSON, which is what a trace of the server's span shows.
class DeclaredFailure {
  readonly [ErrorReporter.ignore] = true;
  readonly json: Schema.Json;

  constructor(json: Schema.Json) {
    this.json = json;
  }

  toString() {
    return Predicate.isString(this.json)
      ? this.json
      : JSON.stringify(this.json);
  }
}

const asJson = () =>
  Schema.link<DeclaredFailure>()(
    Schema.Json,
    SchemaTransformation.transform({
      decode: (json) => new DeclaredFailure(json),
      encode: (failure) => failure.json,
    })
  );

// Why: every codec a protocol derives hands the wrapper over as its JSON: one passing values
// would otherwise pass the wrapper itself, which structured cloning refuses.
const Declared = Schema.instanceOf(DeclaredFailure, {
  toCodecJson: asJson,
  toCodecIso: asJson,
});

const streamOf = (name: string) =>
  Rpc.make(name, {
    payload: Schema.Json,
    success: Schema.Json,
    error: Declared,
    stream: true,
  });

// Why: an action and an event type are JSON contracts on every surface, so both ends hand the
// protocol an action's input, answer and declared failure, and a subscription's input, what it
// sends and its declared failure, as JSON, encoding and decoding them by the contract's schemas
// themselves: the protocol's codec never sees a contract's own schema, and a native rpc sharing
// one keeps its own codec.
const erasedOf = (
  actions: readonly Action.Any[],
  events: readonly Event.Any[]
) =>
  RpcGroup.make(
    ...actions.map((action) =>
      streams(action)
        ? streamOf(action.name)
        : Rpc.make(action.name, {
            payload: Schema.Json,
            success: Schema.Json,
            error: Declared,
          })
    ),
    ...events.map((event) => streamOf(event.name))
  );

const callBoundaryOf = (error: Schema.Union<Action.Errors>) => {
  const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(error));

  return <A, R>(
    effect: Effect.Effect<A, unknown, R>
  ): Effect.Effect<A, unknown, R> =>
    Effect.catchCause(effect, (cause) => {
      if (Cause.hasDies(cause)) {
        return concealed(cause);
      }

      const failure = Cause.findFail(cause);

      return Result.isSuccess(failure)
        ? encode(failure.success.error).pipe(
            Effect.matchCauseEffect({
              onFailure: (unencoded) =>
                concealed(Cause.combine(cause, unencoded)),
              onSuccess: (encoded) => Effect.fail(new DeclaredFailure(encoded)),
            })
          )
        : Effect.failCause(cause);
    });
};

const handlerOf = (
  action: Action.Any,
  run: ErasedHandler<unknown>,
  steps: readonly Step[],
  error: Schema.Union<Action.Errors>
) => {
  const decode = decodeInput(action);

  const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(action.success));
  const boundary = callBoundaryOf(error);

  return (payload: Schema.Json, options: Omit<CallOptions, "payload">) => {
    const call = Effect.suspend(() => decode(payload)).pipe(
      Effect.flatMap(run),
      Effect.flatMap(encode)
    );

    const wrapped = throughSteps(steps, call, { ...options, payload });

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Erased call boundary: the steps pass the call's encoded success through, or fail; the boundary fails with a declared failure in its wrapper alone, or an interruption.
    return boundary(wrapped) as Effect.Effect<
      Schema.Json,
      DeclaredFailure,
      unknown
    >;
  };
};

/** What the stream rpc of an action sends for one call, what its handler reports included. */
type Sending = (
  input: ErasedValue,
  reporting: Reporting,
  send: (sent: Progressed) => Effect.Effect<void>
) => Effect.Effect<void, unknown, unknown>;

/**
 * The handler of the stream rpc of an action declaring `progress` or answering a stream: its call
 * authenticates before its stream starts, then runs in the call's scope, what `sending` sends sent
 * one at a time, so a caller reading slowly holds up the call, whose progress then drops the
 * oldest values. A failure ends the stream as a call's ends it.
 */
const streamingHandlerOf = (
  action: Action.Any,
  sending: Sending,
  steps: readonly Step[],
  error: Schema.Union<Action.Errors>
) => {
  const decode = decodeInput(action);
  const boundary = callBoundaryOf(error);

  const encodeProgress = Schema.encodeUnknownEffect(
    Schema.toCodecJson(action.progress ?? Schema.Never)
  );

  return (payload: Schema.Json, options: Omit<CallOptions, "payload">) => {
    const call = Effect.gen(function* () {
      const input = yield* decode(payload);
      const sent = yield* Queue.bounded<Progressed, unknown>(1);
      const send = (each: Progressed) => Effect.asVoid(Queue.offer(sent, each));

      yield* sending(
        input,
        {
          progress: (value) =>
            Effect.flatMap(Effect.orDie(encodeProgress(value)), (json) =>
              send(Progressed.Progress({ value: json }))
            ),
        },
        send
      ).pipe(
        boundary,
        Queue.into(sent),
        Effect.forkScoped({ startImmediately: true })
      );

      return sent;
    });

    const wrapped = throughSteps(steps, call, { ...options, payload });

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Erased call boundary: the steps pass the call's queue through, or fail; the boundary fails with a declared failure in its wrapper alone, or an interruption.
    return boundary(wrapped) as Effect.Effect<
      Queue.Dequeue<Schema.Json, DeclaredFailure | Cause.Done>,
      DeclaredFailure,
      Scope.Scope
    >;
  };
};

/** Each value `run` reports sent as a `Progress`, then its answer as a `Final`. */
const sendingAnswer = (
  success: Codec,
  run: ErasedHandler<unknown>
): Sending => {
  const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(success));

  return (input, reporting, send) =>
    run(input, reporting).pipe(
      Effect.flatMap(encode),
      Effect.flatMap((value) => send(Progressed.Final({ value })))
    );
};

/** Each element of the stream `run` answers sent as an `Element`, beside its progress. */
const sendingElements = (
  element: Codec,
  run: ErasedHandler<unknown>
): Sending => {
  const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(element));

  return (input, reporting, send) =>
    Stream.runForEach(elementsOf(run(input, reporting)), (each) =>
      Effect.flatMap(encode(each), (value) =>
        send(Progressed.Element({ value }))
      )
    );
};

/**
 * One event subscription a `SubscriptionKeeper` keeps, as it arrived: the request a keeper writes
 * to the server again, once restarted, with the payload `resumeFrom` gave for the last value sent.
 */
export interface KeptSubscription {
  readonly clientId: number;
  readonly requestId: string | number;
  readonly tag: string;
  /** The subscription's payload, an object of its `input` and the `cursor` it resumes from. */
  readonly payload: Schema.Json;
  /** The headers the request was authenticated with, which a resumed one is authenticated with again. */
  readonly headers: ReadonlyArray<readonly [string, string]>;
  /**
   * The payload that resumes the subscription after `values`, a chunk sent for it, or
   * `undefined` where they reach no position.
   */
  readonly resumeFrom: (
    values: RpcMessage.ResponseChunkEncoded["values"]
  ) => Schema.Json | undefined;
}

/**
 * What a protocol keeping event subscriptions across restarts of its server offers under
 * `subscriptionKeeper`, as the Cloudflare package's `layerWebSocket` does: `layer` hands it each
 * subscription once admitted, and sends every position the subscription reaches, with no
 * 30-second heartbeat, whose timer would keep such a host awake.
 */
export interface SubscriptionKeeper {
  readonly keep: (subscription: KeptSubscription) => Effect.Effect<void>;
}

/** The key a protocol sets to its `SubscriptionKeeper` on its `RpcServer.Protocol` service. */
export const subscriptionKeeper: unique symbol = Symbol.for(
  "effect-actions/ActionRpc/subscriptionKeeper"
);

const keeperOf = (
  protocol: RpcServer.Protocol["Service"]
): SubscriptionKeeper | undefined => {
  const kept = Predicate.hasProperty(protocol, subscriptionKeeper)
    ? protocol[subscriptionKeeper]
    : undefined;

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: A protocol's own declaration under the library's own key, which only a `SubscriptionKeeper` is set to.
  return kept as SubscriptionKeeper | undefined;
};

/**
 * The handler of one event type's stream rpc: the subscription's request authenticates and is
 * admitted before its stream starts, so a refusal fails the call; the feed is then read from the
 * call, in its scope, into a bounded queue, each element encoded, and read on through a source's
 * failure, before its first `Checked` too. A later refusal ends the stream as a declared failure.
 * Over a protocol with a `keeper`, the admitted subscription is kept, and every position sent.
 */
const subscriptionHandlerOf = (
  feed: Feed,
  steps: readonly Step[],
  error: Schema.Union<Action.Errors>,
  keeper: SubscriptionKeeper | undefined
) => {
  const decode = Schema.decodeUnknownEffect(Subscription, inputParseOptions);
  const decodeEventInput = decodeInput(feed.event);

  const sent = Schema.toCodecJson(PushedOf(feed.event));
  const encode = Schema.encodeEffect(sent);
  const decodeSent = Schema.decodeUnknownOption(sent);
  const boundary = callBoundaryOf(error);

  return (payload: Schema.Json, options: Omit<CallOptions, "payload">) => {
    const call = Effect.gen(function* () {
      const { input, cursor } = yield* Effect.mapError(
        decode(payload),
        InvalidInput.fromSchemaError
      );

      const open = yield* feed.stream(yield* decodeEventInput(input));

      if (keeper === undefined) {
        return yield* queuedPush(open, cursor, encode, { ending: boundary });
      }

      yield* keeper.keep({
        clientId: options.client.id,
        requestId: options.requestId,
        tag: feed.event.name,
        payload,
        headers: Object.entries(options.headers),
        resumeFrom: (values) => {
          const reached = values
            .flatMap((value) => Option.toArray(decodeSent(value)))
            .map((pushed) =>
              Match.value(pushed).pipe(
                Match.tag("Failed", () => null),
                Match.orElse((positioned) => positioned.cursor)
              )
            )
            .findLast(Predicate.isNotNull);

          return reached === undefined ? undefined : { input, cursor: reached };
        },
      });

      return yield* queuedPush(open, cursor, encode, {
        ending: boundary,
        inOrder: true,
      });
    });

    const wrapped = throughSteps(steps, call, { ...options, payload });

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Erased call boundary: the steps pass the subscription's queue through, or fail; the boundary fails with a declared failure in its wrapper alone, or an interruption.
    return boundary(wrapped) as Effect.Effect<
      Queue.Dequeue<Schema.Json, DeclaredFailure | Cause.Done>,
      DeclaredFailure,
      Scope.Scope
    >;
  };
};

/**
 * The key a protocol answering each call once sets to `true` on its `RpcServer.Protocol`
 * service, as the Cloudflare package's stub protocol does, since Effect's protocol has no flag of
 * its own for it: `layer` refuses to serve a streaming action, an event type or a native stream
 * rpc on it, where a stream is answered with a defect at its first element and one with none
 * waits for good.
 */
export const unaryProtocol: unique symbol = Symbol.for(
  "effect-actions/ActionRpc/unary"
);

// Why: a verifier's defect is masked as on an action, `Internal server error` with its
// cause reported: Effect's server would answer a native rpc's defect with its message and
// cause, and the authentication step is the library's, not the host's handler. Only the
// verification reads the request made of the message's headers: the native handler reads
// what Effect's server gives it.
const verifyingNative = (verify: Verification, { headers }: CallOptions) =>
  withRequestOf(headers)(verify).pipe(
    Effect.catchCauseIf(Cause.hasDies, concealed)
  );

const requested: Step = (effect, { headers }) => withRequestOf(headers)(effect);

const isUnary = (protocol: RpcServer.Protocol["Service"]) =>
  Predicate.hasProperty(protocol, unaryProtocol) &&
  protocol[unaryProtocol] === true;

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
 * - An rpc's credential is read from its headers alone: an API key `in: "query"` never reaches authentication.
 * - Over a protocol with no router, such as `RpcServer.layerProtocolSocketServer` or `layerProtocolStdio`, there is no route: a provider publishing a `protectedResource` leaves `HttpRouter` owed; the request a handler or a verifier reads is, on every protocol, one holding the message's headers, at `/`, with no query or body.
 * - An event's stream rpc takes `{ input, cursor }`, a `cursor` omitted or `null` reading from now, and streams `Checked`, `Occurrence`, `Gap` and `Failed`, a `Checked` every 30 seconds; over `RpcServer.layerProtocolHttp` serialize with `RpcSerialization.layerNdjson`: under `layerJson` a response is sent once its streams end, so a watch never answers.
 * - A subscription refused when it starts or later ends its stream rpc with the refusal as the typed failure; a source's failure no refusal explains is logged and reported once, sent as a bare `Failed`, and read again from where it reached after 5 seconds.
 * - A stream is read only as fast as its client reads it: a slow reader of a log source falls behind its log, and receives a `Gap`.
 * - An action declaring `progress` streams it to every call, a client's call without `onProgress` too, its values handed on one at a time, so a slow reader drops the oldest; under `RpcSerialization.layerJson` over HTTP they arrive with the answer, at the end.
 * - A failure after an action's progress or its first element ends its stream rpc as it ends any call: a declared failure as the typed failure, a defect as `Internal server error`.
 * - The binding's native `rpcs` are served on the same protocol with their own schemas, every one, whatever `actions` lists, and their handlers are owed until provided: `Rpc.rpcs.toLayer(handlers)`; a native rpc's defect or undeclared failure is answered as Effect's server answers it, never `Internal server error`, and only its verifier's defect is.
 * - On a protocol answering each call once, one setting `unaryProtocol`, such as a Durable Object stub's, the build fails while it would serve a streaming action, an event type or a native stream rpc.
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

  const jsonGroup = erasedOf(actions, eventTypes);

  const natives = [...nativeOf(binding.rpcs).requests.values()];

  // Why: every native rpc is served whatever `actions` selects, so a binding holding one needs
  // its authentication as a served protected action does.
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

      const protocol = yield* RpcServer.Protocol;
      const keeper = keeperOf(protocol);

      if (isUnary(protocol)) {
        const streamed = [...actions.filter(streams), ...eventTypes].map(
          ({ name }) => name
        );

        const nativeStreams = natives.flatMap((rpc) =>
          RpcSchema.isStreamSchema(rpc.successSchema) ? [rpc._tag] : []
        );

        if (streamed.length + nativeStreams.length > 0) {
          return yield* Effect.die(
            new Error(
              `ActionRpc.layer serves a protocol answering each call once, and ${[...streamed, ...nativeStreams].join(", ")} stream: serve them over a socket or HTTP, and on this protocol the others, ${nativeStreams.length > 0 ? "from a binding whose rpcs do not stream, " : ""}listed in actions`
            )
          );
        }
      }

      const listedMiddleware: readonly Step[] = yield* Effect.forEach(
        middleware,
        (key) => Effect.service(key)
      );

      const authenticating =
        authentication === undefined
          ? undefined
          : yield* authenticatingOf(authentication);

      const bound = yield* acquire(apps, authentication);
      const feeds = yield* acquireFeeds(events);

      const stepsOf = (caller: Action.Any["caller"]): readonly Step[] =>
        caller === Anyone || authenticating === undefined
          ? [...listedMiddleware, requested]
          : [
              ...listedMiddleware,
              authenticating((verify) => verify),
              requested,
            ];

      const handlerFor = (
        action: Action.Any,
        run: ErasedHandler<unknown>,
        steps: readonly Step[],
        error: Schema.Union<Action.Errors>
      ) => {
        const element = elementOf(action.success);

        if (element !== undefined) {
          return streamingHandlerOf(
            action,
            sendingElements(element, run),
            steps,
            error
          );
        }

        return action.progress === undefined
          ? handlerOf(action, run, steps, error)
          : streamingHandlerOf(
              action,
              sendingAnswer(action.success, run),
              steps,
              error
            );
      };

      const byName = {
        ...Object.fromEntries(
          bound.map(
            ([action, run]) =>
              [
                action.name,
                handlerFor(
                  action,
                  run,
                  stepsOf(action.caller),
                  Schema.Union(bindingErrors(action, binding))
                ),
              ] as const
          )
        ),
        ...Object.fromEntries(
          feeds.map(
            (feed) =>
              [
                feed.event.name,
                subscriptionHandlerOf(
                  feed,
                  stepsOf(feed.event.caller),
                  Schema.Union(eventErrors(feed.event, binding)),
                  keeper
                ),
              ] as const
          )
        ),
      };

      const servedActions = jsonGroup.toLayer(byName);

      // Why: its implementation is always this layer's own, provided beneath the server, so no
      // Layer of the host's under its key reaches it.
      const authenticated = natives
        .map(authenticatedIn)
        .find(Predicate.isNotUndefined);

      if (authenticated === undefined || authenticating === undefined) {
        return servedActions;
      }

      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Erased middleware: the step passes the call's success through, or fails with a refusal or the verifier's error, which the middleware declares, and provides the identity it declares.
      const authenticate = authenticating(
        verifyingNative
      ) as RpcMiddleware.RpcMiddleware<unknown, unknown, never>;

      return Layer.merge(
        servedActions,
        Layer.succeed(authenticated)(authenticate)
      );
    })
  ).pipe(provideServed(selected));

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
 * `InvalidInput`, the binding's errors, an `Event.SubscriptionError` (`Unsupported` for
 * `mode: "poll"`, which rpcs do not serve, `NotServed` for an event the server does not serve), or
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
 * The native `RpcClient.make` options `client` takes: `spanPrefix`, `spanAttributes`,
 * `generateRequestId` and `disableTracing`. `flatten` changes the client's shape, which the
 * method types cannot follow.
 */
export type ClientOptions = Omit<
  NonNullable<Parameters<typeof RpcClient.make>[1]>,
  "flatten"
>;

type Failed = DeclaredFailure | RpcClientError.RpcClientError;

type JsonMethod = (payload: Schema.Json) => Effect.Effect<Schema.Json, Failed>;

type JsonStreamMethod = (
  payload: Schema.Json
) => Stream.Stream<Schema.Json, Failed>;

const isDeclared = (failure: Failed): failure is DeclaredFailure =>
  failure instanceof DeclaredFailure;

/** Fail with the declared failure a wrapper holds, decoded by `error`, or die where it does not. */
const failedOf = (error: Schema.Union<Action.Errors>) => {
  const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(error));

  return (failure: DeclaredFailure) =>
    Effect.flatMap(Effect.orDie(decode(failure.json)), Effect.fail);
};

/**
 * A client's method of `action`, calling `method`, its rpc of `erasedOf`, with its input's JSON:
 * what the server sends, its answer or each element it streams, and its declared failure, decoded
 * by the action's schemas; one that does not decode is a defect, as the native client makes it.
 */
const actionMethodOf = (
  action: Action.Any,
  binding: Any,
  method: JsonMethod | JsonStreamMethod
): ErasedMethod | ErasedStreamMethod => {
  const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(sentOf(action)));
  const failed = failedOf(Schema.Union(bindingErrors(action, binding)));

  const sent = (json: Schema.Json) => Effect.orDie(decode(json));

  if (!streams(action)) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: The native client's method of an rpc of `erasedOf` that does not stream: it takes and answers JSON, failing with the declared failure's wrapper.
    const call = method as JsonMethod;

    return checked(action, sendingJson, (json) =>
      call(json).pipe(Effect.catchIf(isDeclared, failed), Effect.flatMap(sent))
    );
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: The native client's method of a stream rpc of `erasedOf`: it streams JSON, failing with the declared failure's wrapper.
  const call = method as JsonStreamMethod;

  const progressed = (json: Schema.Json) =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: What a stream rpc sends decodes by `sentOf` to a `Progress`, `Final` or `Element` holding its value.
    call(json).pipe(
      Stream.catchIf(isDeclared, (failure) =>
        Stream.fromEffect(failed(failure))
      ),
      Stream.mapEffect(sent)
    ) as Stream.Stream<Progressed, unknown>;

  return elementOf(action.success) === undefined
    ? checked(action, sendingJson, (json, onProgress) =>
        answerFrom(progressed(json), onProgress)
      )
    : checkedStream(action, sendingJson, (json, onProgress) =>
        elementsFrom(progressed(json), onProgress)
      );
};

/** A subscription's stream of an event type, from its input's JSON. */
type EventMethod = (input: Schema.Json) => StreamMethod;

/**
 * A client's subscription to `event`, calling `method`, its stream rpc of `erasedOf`, with its
 * input's JSON and the cursor it resumes from: what the server sends, and its declared failure,
 * decoded by the event's schemas; one that does not decode is a defect, as for an action.
 */
const eventMethodOf = (
  event: Event.Any,
  binding: Any,
  method: JsonMethod | JsonStreamMethod
): EventMethod => {
  const decode = Schema.decodeUnknownEffect(
    Schema.toCodecJson(PushedOf(event))
  );

  const failed = failedOf(Schema.Union(eventErrors(event, binding)));

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: The native client's method of an event type's stream rpc of `erasedOf`: it streams JSON, failing with the declared failure's wrapper.
  const call = method as JsonStreamMethod;

  return (input) => (cursor) =>
    call({ input, cursor }).pipe(
      Stream.catchIf(isDeclared, (failure) =>
        Stream.fromEffect(failed(failure))
      ),
      Stream.mapEffect((json) => Effect.orDie(decode(json)))
    );
};

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
 * - `watch(event, input, options)` holds the event's stream rpc open, as `Action.client`'s does; `mode: "poll"` fails with `Event.SubscriptionError`, reason `Unsupported`, since rpcs serve no poll, and a watch of an event the server does not serve fails with it, reason `NotServed`, as over HTTP.
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
  options?: ClientOptions
): Effect.Effect<object, never, RpcClient.Protocol | Scope.Scope> {
  const actions = new Map(
    binding.actions.map((action) => [action.name, action])
  );

  const events = new Map(binding.events.map((event) => [event.name, event]));

  const clients = Effect.all([
    RpcClient.make(
      erasedOf(binding.actions, binding.events).merge(nativeOf(binding.rpcs)),
      options
    ),
    // Why: a protocol acknowledging chunks, such as Effect's socket protocol, holds a connection
    // whose liveness it checks itself, by ping; of the protocols that serve a watch, Effect's HTTP
    // one alone does not, and it reads a response a proxy may hold open without passing frames
    // on, which only a watch's silence rule tells apart (a stub's protocol serves no watch). Over
    // a socket the rule would end every quiet watch, and a Durable Object, which sends no
    // heartbeat, would be woken by its reconnects every minute.
    Effect.map(
      Effect.service(RpcClient.Protocol),
      ({ supportsAck }) => !supportsAck
    ),
  ]);

  return Effect.map(clients, ([native, silenceEnds]) => {
    const rpcs = Object.entries(native);

    const methods = Object.fromEntries(
      rpcs
        .filter(([tag]) => !events.has(tag))
        .map(([tag, method]) => {
          const action = actions.get(tag);

          return [
            tag,
            action === undefined
              ? method
              : actionMethodOf(action, binding, method),
          ];
        })
    );

    if (events.size === 0) {
      return methods;
    }

    const feeds = new Map(
      rpcs.flatMap(([tag, method]) => {
        const event = events.get(tag);

        return event === undefined
          ? []
          : [[tag, eventMethodOf(event, binding, method)] as const];
      })
    );

    const watch = (
      event: Event.Any,
      input?: ErasedValue,
      watchOptions?: Event.WatchOptions<unknown>
    ): Stream.Stream<Event.Received<Event.Any>, unknown> => {
      const feed = feeds.get(event.name);

      if (feed === undefined) {
        return Stream.die(
          new Error(
            `ActionRpc.client: the binding holds no event type ${event.name} (watch one the binding ActionRpc.make returned lists)`
          )
        );
      }

      return Stream.unwrap(
        Effect.map(watchInput(event, input), ({ json }) =>
          watching(transportOf(event, feed(json), silenceEnds), watchOptions)
        )
      );
    };

    return { ...methods, watch };
  });
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
  // Why: a copy of `defaultRetryPolicy` in effect 4.0.6's `src/rpc/RpcClient.ts`, lines 1415-1418,
  // which Effect does not export: on an Effect upgrade, compare it there, as a change of
  // Effect's default leaves this one behind.
  Schedule.min([Schedule.exponential(500, 1.5), Schedule.spaced(5000)]).pipe(
    // Why: the input is typed by the shape it reads, not `Socket.SocketError`, so a page
    // importing this module needs no `effect/socket` in its import map unless it opens a
    // socket itself; `tests/browser.test.ts` holds the barrels it may need.
    Schedule.setInputType<{ readonly reason: unknown }>(),
    Schedule.while(
      ({ input: { reason } }) =>
        !(
          Predicate.isTagged(reason, "SocketCloseError") &&
          Predicate.hasProperty(reason, "code") &&
          codes.some((code) => code === reason.code)
        )
    )
  );
