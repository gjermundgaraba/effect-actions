import {
  Cause,
  type Context,
  Effect,
  ErrorReporter,
  Layer,
  Predicate,
  Queue,
  Result,
  Schedule,
  Schema,
  type Scope,
  Stream,
  type Types,
  SchemaTransformation,
} from "effect";
import { type Headers, HttpClientRequest, type HttpRouter, HttpServerRequest } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  Rpc,
  RpcClient,
  type RpcClientError,
  RpcGroup,
  RpcMiddleware,
  RpcSchema,
  RpcServer,
} from "effect/rpc";
import type * as Action from "../contract/Action.js";
import { Anyone } from "../contract/caller.js";
import { concealed } from "../contract/reported.js";
import { type Certain, type ErrorsOf, bindingErrors, bindingOf } from "../contract/declared.js";
import {
  type Any as Authentication,
  type Descriptor,
  type DescriptorOf,
  type Identity,
  type Matching,
  providerOf,
  type ProviderOf,
  type PublicOnly,
  type RemoteRequest,
  type Required as RequiredAuthentication,
  type Security,
  type ServerBuildServices,
  type ServedProvider,
  type VerifierError,
} from "../authentication/provider.js";
import {
  type Call,
  checked,
  checkedStream,
  decodeInput,
  type ErasedMethod,
  type ErasedStreamMethod,
  sendingJson,
} from "../contract/call.js";
import { type BuiltIn, type BuiltIns, Unauthenticated } from "../contract/errors.js";
import {
  acquire,
  type BuildError,
  elementsOf,
  type ErasedHandler,
  type ErasedValue,
  type Holding,
  type Known,
  type Member,
  type MiddlewareOf,
  type Protected,
  provideHandlers,
  type Selected,
  type Served,
  type Serving,
} from "../contract/implementation.js";
import { servingOf } from "../contract/serving.js";
import type { Codec } from "../contract/codec.js";
import { answerFrom, elementsFrom, Progressed, type Reporting } from "../contract/progress.js";
import { type Answer, elementOf, type StreamOf } from "../contract/stream.js";
import { reservedList, reservedNames } from "../contract/names.js";

type BindingError = Action.Errors[number];

type ErrorOf<A extends Action.Any, E extends Action.Errors, D> = Schema.Union<
  ReadonlyArray<A["error"][number] | E[number] | VerifierError<A, D> | BuiltIns>
>;

/**
 * What the stream rpc of an action declaring `progress` sends: a `Progress` for each value its
 * handler reports, then a `Final` with its answer.
 */
const ProgressedOf = <P extends Codec, S extends Codec>(progress: P, success: S) =>
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
    ...(P extends Codec ? [Schema.TaggedStruct<"Progress", { readonly value: P }>] : []),
  ]
>;

const elementedOf = (element: Codec, progress: Codec | undefined) =>
  Schema.Union([
    Schema.TaggedStruct("Element", { value: element }),
    ...(progress === undefined ? [] : [Schema.TaggedStruct("Progress", { value: progress })]),
  ]);

/** Whether `action`'s rpc is a stream rpc: it answers a stream, or declares `progress`. */
const streams = (action: Action.Any) =>
  action.progress !== undefined || elementOf(action.success) !== undefined;

/** What `action`'s rpc answers, or each element it streams where it is a stream rpc. */
const sentOf = (action: Action.Any): Codec => {
  const element = elementOf(action.success);

  if (element !== undefined) return elementedOf(element, action.progress);

  return action.progress === undefined
    ? action.success
    : ProgressedOf(action.progress, action.success);
};

type RpcOf<A extends Action.Any, E extends Action.Errors, D> = A extends Action.Any
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
 * An RPC binding: actions, the errors every rpc declares, the descriptor authenticating its
 * protected ones, and the native rpcs it serves beside them. Plain data, so a copy of it, or one
 * made by another installed copy of this package, serves the same; `layer` serves it and
 * `client` calls it.
 */
export interface Binding<
  Actions extends ReadonlyArray<Action.Any>,
  E extends Action.Errors = [],
  D extends Authentication | undefined = undefined,
  N extends Rpc.Any = never,
> {
  /** The descriptor authenticating its protected actions, or `undefined` when it names none. */
  readonly authentication: D;
  /** The exact actions bound to this binding. */
  readonly actions: Actions;
  /** The errors every rpc declares besides its action's own, as a list. */
  readonly error: E;
  /**
   * The native rpcs `make`'s `rpcs` gave, as served: under an `authentication`, each runs
   * behind the middleware authenticating it, which provides its handler the identity. A host
   * implements them with `rpcs.toLayer`.
   */
  readonly rpcs: RpcGroup.RpcGroup<NativeOf<N, D>>;
  /**
   * The native group of one rpc per action, named after it, and `rpcs`, as clients see it:
   * `RpcClient.make(Rpc.group)` is the native client.
   *
   * **Gotchas**
   *
   * - `layer` hands the protocol an action's values as their JSON, the native `rpcs`' as they are: under a codec other than a JSON serialization's, such as schema-binary's or a protocol passing values, `RpcClient.make(Rpc.group)` decodes an action's answer by its own schema and fails; call actions through `client`, which hands them over as JSON too.
   */
  readonly group: RpcGroup.RpcGroup<RpcOf<Actions[number], E, D> | NativeOf<N, D>>;
}

/**
 * Any RPC binding. Its groups are any native groups here, since native groups are invariant in
 * their rpcs; `actions` carries the types.
 */
export interface Any {
  readonly authentication?: Authentication | undefined;
  readonly actions: ReadonlyArray<Action.Any>;
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
   * Native rpcs the binding serves beside its actions, with their own schemas and handlers:
   * `RpcGroup.make(Upload)`. Under an `authentication`, each of their messages authenticates as
   * a protected action's does: its handler reads the identity, and a refusal fails the call with
   * `Unauthenticated`.
   *
   * **Gotchas**
   *
   * - `layer` requires their handlers, which the host provides from the binding's own `rpcs`: `Rpc.rpcs.toLayer(handlers)`, whose types then leave the identity unowed.
   * - A native rpc runs no implementation's `authorize`: its handler authorizes the identity itself, as an action's `authorize` would, or every authenticated caller is served.
   * - The layer's `middleware` runs on actions alone: a native rpc runs the native middleware its group adds, inside its authentication.
   * - Native middleware added to the binding's `rpcs` after `make` runs outside the authentication, before the identity exists; added to the group given here, inside it.
   * - `layer` refuses a protected binding holding a native rpc without its authentication, such as one added with `rpcs.add` after `make`: add rpcs to the group given here.
   * - A native rpc named after an action or a name the client keeps, `then` or `watch`, is refused as the binding is made.
   */
  readonly rpcs?: RpcGroup.Any;
}

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Native group boundary: every native group is a `RpcGroup` of native rpcs, each carrying its schemas and middleware; only its invariant static rpcs are dropped.
const nativeOf = (group: RpcGroup.Any) => group as RpcGroup.RpcGroup<Rpc.AnyWithProps>;

type RpcsOf<O> = O extends { readonly rpcs: infer G } ? RpcGroup.Rpcs<G> : never;

// Why: a native rpc's refusal is its own call's typed failure, as an action's is: the
// middleware's error joins the rpc's in the exit both sides encode, so its client decodes
// `Unauthenticated` and the verifier's errors without declaring them. `make` builds it once per
// binding, and `layer` provides its implementation under the one its native rpcs carry.
const authenticatedOf = (authentication: Authentication) =>
  RpcMiddleware.Service<Authenticated<unknown>, { provides: unknown }>()(authenticatedKey, {
    error: Schema.Union([Unauthenticated, ...authentication.error]),
  });

/** The middleware authenticating `rpc`, wherever among its middleware it runs. */
const authenticatedIn = (rpc: Rpc.AnyWithProps) =>
  [...rpc.middlewares].find(({ key }) => key === authenticatedKey);

// Why: The same three overloads as `ActionHttp.make`, for the reasons stated there.
/**
 * Bind actions once, for servers and clients alike, each as an rpc named after it, taking
 * its action's input and answering its success. Every rpc declares its action's errors, the
 * binding's `error`, and the built-in `InvalidInput`, `Unauthenticated` and `Forbidden`, so
 * clients decode each as a typed failure; a protected one also declares what its descriptor's
 * verifier fails with. `rpcs` adds native ones beside them. Browser-safe, as an HTTP binding is.
 * Guide: `docs/ActionRpc.md` in this package; in an application: `examples/live-rpc/`.
 *
 * **Gotchas**
 *
 * - An action and a native rpc of one name throw when `make` is called: they would share a client's method.
 * - An action declaring `progress` is a stream rpc taking its input, streaming `{ _tag: "Progress", value }` for each value its handler reports, then one `{ _tag: "Final", value }` holding its answer: the native client's method of it returns a `Stream`.
 * - An action answering a stream, `Action.Stream`, is a stream rpc taking its input, streaming `{ _tag: "Element", value }` for each element, beside `{ _tag: "Progress", value }` for each value where it declares `progress`; `client`'s method returns a `Stream` of the elements.
 */
export function make<
  const Actions extends ReadonlyArray<Action.Any & { readonly caller: typeof Anyone }>,
>(actions: Actions): Binding<Actions, [], undefined>;
export function make<const Actions extends ReadonlyArray<Action.Any>, const O extends Options = {}>(
  actions: Actions,
  options: O &
    RequiredAuthentication<Actions[number]> &
    Matching<Actions[number], NoInfer<DescriptorOf<O>>> &
    NoInfer<Known<O, Options>>,
): Binding<Actions, ErrorsOf<O>, DescriptorOf<O>, RpcsOf<O>>;
export function make<const Actions extends ReadonlyArray<Action.Any>>(
  actions: Actions & PublicOnly<Actions>,
): Binding<Actions, [], undefined>;
export function make(actions: ReadonlyArray<Action.Any>, options: Options = {}): Any {
  const bound = bindingOf("ActionRpc binding", actions, options);

  const rpcOf = (action: Action.Any) =>
    Rpc.make(action.name, {
      payload: action.input,
      success: sentOf(action),
      error: Schema.Union(bindingErrors(action, bound)),
      stream: streams(action),
    });

  const given = options.rpcs === undefined ? RpcGroup.make() : nativeOf(options.rpcs);

  for (const tag of given.requests.keys()) {
    if (reservedNames.includes(tag) || actions.some((action) => action.name === tag)) {
      throw new Error(
        `ActionRpc binding: the rpc "${tag}" of rpcs is named after an action or a name the client keeps, ${reservedList} (rename it)`,
      );
    }
  }

  const rpcs =
    bound.authentication === undefined
      ? given
      : given.middleware(authenticatedOf(bound.authentication));

  const group = RpcGroup.make(...actions.map(rpcOf)).merge(rpcs);

  return { actions, ...bound, rpcs, group };
}

type Middleware = ReadonlyArray<RpcMiddleware.AnyService>;

type IdOf<K> = K extends Context.Key<infer I extends RpcMiddleware.AnyId, unknown> ? I : never;

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

// Why: every call of an action runs with the request `withRequestOf` makes of its message's
// headers, on every protocol, so the request and its search params are never owed; a route's
// `RouteContext` exists only over a router-mounted protocol, where `HttpRouter.serve` provides
// it, so unlike `ActionHttp`'s, this keeps it owed, and a handler reading one leaves it owed on
// stdio, a socket or a worker.
type LayerRequest<App, A extends Action.Any, M extends Middleware> = Exclude<
  Through<M, RemoteRequest<App, A>>,
  | HttpServerRequest.HttpServerRequest
  | HttpServerRequest.ParsedSearchParams
  | ([Extract<Serving<App, A>, { readonly caller: typeof Anyone }>] extends [never]
      ? Identity<Protected<Serving<App, A>>>
      : never)
>;

type RpcLayer<
  B extends Any,
  Apps extends Served,
  M extends Middleware,
  A extends Action.Any = B["actions"][number],
> = Layer.Layer<
  never,
  BuildError<Holding<Member<Apps>, A>, A>,
  | ServerBuildServices<Holding<Member<Apps>, A>, A>
  | RpcServer.Protocol
  | HttpRouter.Request.From<"Requires", LayerRequest<Member<Apps>, A, M>>
  | ServedProvider<Member<Apps>, A, B extends { readonly authentication: infer D } ? D : never>
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
export interface LayerOptions<M extends Middleware = [], A extends Action.Any = never> {
  /**
   * The actions it serves, among the binding's actions the implementations hold: `[GetUser]`.
   * Defaults to every one of them.
   */
  readonly actions?: ReadonlyArray<A> | undefined;
  /**
   * Native rpc middleware every served rpc runs on each message, the first innermost: inside
   * the authentication of a protected rpc, so none provides what a verifier reads, and outside
   * its decoding, so it also sees input that does not decode. Server-only: the binding's group,
   * which clients use, carries none.
   *
   * **Gotchas**
   *
   * - A middleware requiring the identity leaves it owed on a layer serving a public action: bind the protected actions apart, or read the identity with `Effect.serviceOption`, which a public rpc's call lacks.
   * - A middleware provides a service only to those listed before it and the handlers, and only in a list written in place as a tuple: listed earlier, or in an array-typed list, it leaves the service owed.
   * - Router middleware around the layer runs once per WebSocket, at its upgrade, so its value holds for the whole connection: what differs per message needs a listed middleware.
   * - On the stream rpc of an action declaring `progress` or answering a stream they run around its start alike, before its handler runs: one timing it sees it end before the handler does, and never sees its failure; what it provides lasts the handler.
   */
  readonly middleware?: M;
}

// Why: a message carries headers alone, and no transport gives a call its request: a server
// on a socket runs in a fiber of its own, and a hibernated object's message arrives with none. A
// verifier is typed as reading the request, as over HTTP, so it reads one holding the message's
// headers, which a socket's upgrade headers precede, where the credential is decoded from too;
// every call runs with it, so a handler reads the same request.
const withRequestOf =
  (headers: Headers.Headers) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromClientRequest(HttpClientRequest.get("/", { headers })),
      ),
      Effect.provideService(HttpServerRequest.ParsedSearchParams, {}),
    );

type CallOptions = Parameters<RpcMiddleware.RpcMiddleware<never, never, never>>[1];

type Step = (
  effect: Effect.Effect<unknown, unknown, unknown>,
  options: CallOptions,
) => Effect.Effect<unknown, unknown, unknown>;

// Why: The steps run here, each suspended, and none as native rpc middleware. Effect applies
// native middleware as it sets a call up, outside any Effect, so one that throws fails the whole
// connection; suspended, a throw is its own call's defect.
/** `call` inside `steps`, the first innermost, each given the call's options. */
const throughSteps = (
  steps: ReadonlyArray<Step>,
  call: Effect.Effect<unknown, unknown, unknown>,
  options: CallOptions,
) =>
  steps.reduce<Effect.Effect<unknown, unknown, unknown>>(
    (inner, step) => Effect.suspend(() => step(inner, options)),
    call,
  );

/**
 * The step authenticating a call with `authentication`'s provider: the identity its verification
 * answers is provided to the call, the verification run as `verifying` runs it.
 */
const authenticatingOf = (authentication: Authentication) =>
  Effect.map(providerOf(authentication), (provider) => {
    const verify = Effect.flatMap(
      HttpApiBuilder.securityDecode(authentication.security),
      provider.authenticate,
    );

    return (verifying: (verify: Verification, options: CallOptions) => Verification): Step =>
      (effect, options) =>
        Effect.flatMap(verifying(verify, options), (actor) =>
          Effect.provideService(effect, authentication.identity, actor),
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
    return Predicate.isString(this.json) ? this.json : JSON.stringify(this.json);
  }
}

const asJson = () =>
  Schema.link<DeclaredFailure>()(
    Schema.Json,
    SchemaTransformation.transform({
      decode: (json) => new DeclaredFailure(json),
      encode: (failure) => failure.json,
    }),
  );

// Why: every codec a protocol derives hands the wrapper over as its JSON: one passing values
// would otherwise pass the wrapper itself, which structured cloning refuses.
const Declared = Schema.instanceOf(DeclaredFailure, {
  toCodecJson: asJson,
  toCodecIso: asJson,
});

// Why: an action is a JSON contract on every surface, so both ends hand the protocol its input,
// answer and declared failure as JSON, encoding and decoding them by the action's schemas
// themselves: the protocol's codec never sees an action's own schema, and a native rpc sharing
// one keeps its own codec.
const erasedOf = (actions: ReadonlyArray<Action.Any>) =>
  RpcGroup.make(
    ...actions.map((action) =>
      streams(action)
        ? Rpc.make(action.name, {
            payload: Schema.Json,
            success: Schema.Json,
            error: Declared,
            stream: true,
          })
        : Rpc.make(action.name, { payload: Schema.Json, success: Schema.Json, error: Declared }),
    ),
  );

const callBoundaryOf = (error: Schema.Union<Action.Errors>) => {
  const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(error));

  return <A, R>(effect: Effect.Effect<A, unknown, R>): Effect.Effect<A, unknown, R> =>
    Effect.catchCause(effect, (cause) => {
      if (Cause.hasDies(cause)) return concealed(cause);

      const failure = Cause.findFail(cause);

      return Result.isSuccess(failure)
        ? encode(failure.success.error).pipe(
            Effect.matchCauseEffect({
              onFailure: (unencoded) => concealed(Cause.combine(cause, unencoded)),
              onSuccess: (encoded) => Effect.fail(new DeclaredFailure(encoded)),
            }),
          )
        : Effect.failCause(cause);
    });
};

const handlerOf = (
  action: Action.Any,
  run: ErasedHandler<unknown>,
  steps: ReadonlyArray<Step>,
  error: Schema.Union<Action.Errors>,
) => {
  const decode = decodeInput(action);

  const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(action.success));
  const boundary = callBoundaryOf(error);

  return (payload: Schema.Json, options: Omit<CallOptions, "payload">) => {
    const call = Effect.suspend(() => decode(payload)).pipe(
      Effect.flatMap(run),
      Effect.flatMap(encode),
    );

    const wrapped = throughSteps(steps, call, { ...options, payload });

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased call boundary: the steps pass the call's encoded success through, or fail; the boundary fails with a declared failure in its wrapper alone, or an interruption.
    return boundary(wrapped) as Effect.Effect<Schema.Json, DeclaredFailure, unknown>;
  };
};

/** What the stream rpc of an action sends for one call, what its handler reports included. */
type Sending = (
  input: ErasedValue,
  reporting: Reporting,
  send: (sent: Progressed) => Effect.Effect<void>,
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
  steps: ReadonlyArray<Step>,
  error: Schema.Union<Action.Errors>,
) => {
  const decode = decodeInput(action);
  const boundary = callBoundaryOf(error);

  const encodeProgress = Schema.encodeUnknownEffect(
    Schema.toCodecJson(action.progress ?? Schema.Never),
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
              send(Progressed.Progress({ value: json })),
            ),
        },
        send,
      ).pipe(boundary, Queue.into(sent), Effect.forkScoped({ startImmediately: true }));

      return sent;
    });

    const wrapped = throughSteps(steps, call, { ...options, payload });

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased call boundary: the steps pass the call's queue through, or fail; the boundary fails with a declared failure in its wrapper alone, or an interruption.
    return boundary(wrapped) as Effect.Effect<
      Queue.Dequeue<Schema.Json, DeclaredFailure | Cause.Done>,
      DeclaredFailure,
      Scope.Scope
    >;
  };
};

/** Each value `run` reports sent as a `Progress`, then its answer as a `Final`. */
const sendingAnswer = (success: Codec, run: ErasedHandler<unknown>): Sending => {
  const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(success));

  return (input, reporting, send) =>
    run(input, reporting).pipe(
      Effect.flatMap(encode),
      Effect.flatMap((value) => send(Progressed.Final({ value }))),
    );
};

/** Each element of the stream `run` answers sent as an `Element`, beside its progress. */
const sendingElements = (element: Codec, run: ErasedHandler<unknown>): Sending => {
  const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(element));

  return (input, reporting, send) =>
    Stream.runForEach(elementsOf(run(input, reporting)), (each) =>
      Effect.flatMap(encode(each), (value) => send(Progressed.Element({ value }))),
    );
};

/**
 * The key a protocol answering each call once sets to `true` on its `RpcServer.Protocol`
 * service, since Effect's protocol has no flag of its own for it: `layer` refuses to serve a
 * streaming action or a native stream rpc on it, where a stream is answered with a defect at its
 * first element and one with none waits for good.
 */
export const unaryProtocol: unique symbol = Symbol.for("effect-actions/ActionRpc/unary");

const isUnary = (protocol: RpcServer.Protocol["Service"]) =>
  Predicate.hasProperty(protocol, unaryProtocol) && protocol[unaryProtocol] === true;

/**
 * Serve the binding's actions among `implementations` with Effect's own `RpcServer`, or those
 * its `actions` lists, as `ActionHttp.layer` selects them, under the protocol and serialization
 * the host provides. Each message of a protected rpc authenticates from its own headers with
 * the binding's descriptor; then the listed `middleware` runs, the input decodes,
 * and the implementation's `authorize` and the handler run, as on every surface. The layer
 * fails as the builders do and needs at startup what they need; per request it owes, as router
 * request markers, what the authorizers and handlers read until its `middleware` provides it,
 * or, over a router-mounted protocol, the route's request context.
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
 * - An action declaring `progress` streams it to every call, a client's call without `onProgress` too, its values handed on one at a time, so a slow reader drops the oldest; under `RpcSerialization.layerJson` over HTTP they arrive with the answer, at the end.
 * - A failure after an action's progress or its first element ends its stream rpc as it ends any call: a declared failure as the typed failure, a defect as `Internal server error`.
 * - The binding's native `rpcs` are served on the same protocol with their own schemas, every one, whatever `actions` lists, and their handlers are owed until provided: `Rpc.rpcs.toLayer(handlers)`; a native rpc's defect or undeclared failure is answered as Effect's server answers it, never `Internal server error`, and only its verifier's defect is.
 * - On a protocol answering each call once, one setting `unaryProtocol`, such as a Durable Object stub's, the build fails while it would serve a streaming action or a native stream rpc.
 */
export function layer<const B extends Any, const Apps extends Served>(
  binding: B,
  implementations: Apps,
): RpcLayer<B, Apps, []>;
export function layer<
  const B extends Any,
  const Apps extends Served,
  const O extends LayerOptions<Middleware, B["actions"][number]>,
>(
  binding: B,
  implementations: Apps,
  options: O &
    ServerOnly<MiddlewareOf<O, Middleware>, B["error"]> &
    NoInfer<Known<O, LayerOptions<Middleware>>>,
): RpcLayer<B, Apps, MiddlewareOf<O, Middleware>, Selected<O, B["actions"][number]>>;
export function layer(
  binding: Any,
  served: Served,
  options: LayerOptions<Middleware> = {},
): Layer.Layer<never, unknown, unknown> {
  const selected = servingOf("RPC binding", binding, served, options);
  const { apps, actions } = selected;

  const middleware = options.middleware ?? [];

  const jsonGroup = erasedOf(actions);

  const natives = [...nativeOf(binding.rpcs).requests.values()];

  // Why: every native rpc is served whatever `actions` selects, so a binding holding one needs
  // its authentication as a served protected action does.
  const authentication = natives.length === 0 ? selected.authentication : binding.authentication;

  const handlers = Layer.unwrap(
    Effect.gen(function* () {
      const unauthenticated =
        authentication === undefined
          ? undefined
          : natives.find((rpc) => authenticatedIn(rpc) === undefined);

      if (unauthenticated !== undefined) {
        return yield* Effect.die(
          new Error(
            `ActionRpc.layer: the native rpc ${unauthenticated._tag} of a protected binding runs without its authentication: add it to the group ActionRpc.make is given as its rpcs, not to the binding's rpcs after`,
          ),
        );
      }

      const protocol = yield* RpcServer.Protocol;

      if (isUnary(protocol)) {
        const streamed = actions.filter(streams).map(({ name }) => name);

        const nativeStreams = natives
          .filter((rpc) => RpcSchema.isStreamSchema(rpc.successSchema))
          .map((rpc) => rpc._tag);

        if (streamed.length + nativeStreams.length > 0) {
          return yield* Effect.die(
            new Error(
              `ActionRpc.layer serves a protocol answering each call once, and ${[...streamed, ...nativeStreams].join(", ")} stream: serve them over a socket or HTTP, and on this protocol the others, ${nativeStreams.length > 0 ? "from a binding whose rpcs do not stream, " : ""}listed in actions`,
            ),
          );
        }
      }

      const listedMiddleware: ReadonlyArray<Step> = yield* Effect.forEach(middleware, (key) =>
        Effect.service(key),
      );

      const authenticating =
        authentication === undefined ? undefined : yield* authenticatingOf(authentication);

      const bound = yield* acquire(apps);

      const requested: Step = (effect, { headers }) => withRequestOf(headers)(effect);

      const stepsOf = (caller: Action.Any["caller"]): ReadonlyArray<Step> =>
        caller === Anyone || authenticating === undefined
          ? [...listedMiddleware, requested]
          : [...listedMiddleware, authenticating((verify) => verify), requested];

      const handlerFor = (
        action: Action.Any,
        run: ErasedHandler<unknown>,
        steps: ReadonlyArray<Step>,
        error: Schema.Union<Action.Errors>,
      ) => {
        const element = elementOf(action.success);

        if (element !== undefined)
          return streamingHandlerOf(action, sendingElements(element, run), steps, error);

        return action.progress === undefined
          ? handlerOf(action, run, steps, error)
          : streamingHandlerOf(action, sendingAnswer(action.success, run), steps, error);
      };

      const byName = Object.fromEntries(
        bound.map(
          ([action, run]) =>
            [
              action.name,
              handlerFor(
                action,
                run,
                stepsOf(action.caller),
                Schema.Union(bindingErrors(action, binding)),
              ),
            ] as const,
        ),
      );

      const servedActions = jsonGroup.toLayer(byName);

      // Why: its implementation is always this layer's own, provided beneath the server, so no
      // Layer of the host's under its key reaches it.
      const authenticated = natives.map(authenticatedIn).find(Predicate.isNotUndefined);

      if (authenticated === undefined || authenticating === undefined) return servedActions;

      // Why: a verifier's defect is masked as on an action, `Internal server error` with its
      // cause reported: Effect's server would answer a native rpc's defect with its message and
      // cause, and the authentication step is the library's, not the host's handler. Only the
      // verification reads the request made of the message's headers: the native handler reads
      // what Effect's server gives it.
      const verifyingNative = (verify: Verification, { headers }: CallOptions) =>
        withRequestOf(headers)(verify).pipe(
          Effect.catchCause((cause) =>
            Cause.hasDies(cause) ? concealed(cause) : Effect.failCause(cause),
          ),
        );

      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased middleware: the step passes the call's success through, or fails with a refusal or the verifier's error, which the middleware declares, and provides the identity it declares.
      const authenticate = authenticating(verifyingNative) as RpcMiddleware.RpcMiddleware<
        unknown,
        unknown,
        never
      >;

      return Layer.merge(servedActions, Layer.succeed(authenticated)(authenticate));
    }),
  ).pipe(provideHandlers(apps));

  return RpcServer.layer(jsonGroup.merge(binding.rpcs), { disableFatalDefects: true }).pipe(
    Layer.provide(handlers),
  );
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
 * Every action of the binding `B`, as `client.<action>(input)`: a protected one may also fail
 * with what its descriptor's verifier declares; each native rpc of its `rpcs` is the native
 * client's method.
 */
export type Client<B extends Any> = {
  readonly [A in B["actions"][number] as A["name"]]: Method<
    A,
    B["error"][number] | VerifierError<A, B["authentication"]>
  >;
} & RpcClient.RpcClient<RpcGroup.Rpcs<B["rpcs"]>, RpcClientError.RpcClientError>;

/**
 * The native `RpcClient.make` options `client` takes: `spanPrefix`, `spanAttributes`,
 * `generateRequestId` and `disableTracing`. `flatten` changes the client's shape, which the
 * method types cannot follow.
 */
export type ClientOptions = Omit<NonNullable<Parameters<typeof RpcClient.make>[1]>, "flatten">;

type Failed = DeclaredFailure | RpcClientError.RpcClientError;

type JsonMethod = (payload: Schema.Json) => Effect.Effect<Schema.Json, Failed>;

type JsonStreamMethod = (payload: Schema.Json) => Stream.Stream<Schema.Json, Failed>;

const isDeclared = (failure: Failed): failure is DeclaredFailure =>
  failure instanceof DeclaredFailure;

/**
 * A client's method of `action`, calling `method`, its rpc of `erasedOf`, with its input's JSON:
 * what the server sends, its answer or each element it streams, and its declared failure, decoded
 * by the action's schemas; one that does not decode is a defect, as the native client makes it.
 */
const actionMethodOf = (
  action: Action.Any,
  binding: Any,
  method: JsonMethod | JsonStreamMethod,
): ErasedMethod | ErasedStreamMethod => {
  const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(sentOf(action)));

  const decodeFailure = Schema.decodeUnknownEffect(
    Schema.toCodecJson(Schema.Union(bindingErrors(action, binding))),
  );

  const sent = (json: Schema.Json) => Effect.orDie(decode(json));

  const failed = (failure: DeclaredFailure) =>
    Effect.flatMap(Effect.orDie(decodeFailure(failure.json)), Effect.fail);

  if (!streams(action)) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The native client's method of an rpc of `erasedOf` that does not stream: it takes and answers JSON, failing with the declared failure's wrapper.
    const call = method as JsonMethod;

    return checked(action, sendingJson, (json) =>
      call(json).pipe(Effect.catchIf(isDeclared, failed), Effect.flatMap(sent)),
    );
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The native client's method of a stream rpc of `erasedOf`: it streams JSON, failing with the declared failure's wrapper.
  const call = method as JsonStreamMethod;

  const progressed = (json: Schema.Json) =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- What a stream rpc sends decodes by `sentOf` to a `Progress`, `Final` or `Element` holding its value.
    call(json).pipe(
      Stream.catchIf(isDeclared, (failure) => Stream.fromEffect(failed(failure))),
      Stream.mapEffect(sent),
    ) as Stream.Stream<Progressed, unknown>;

  return elementOf(action.success) === undefined
    ? checked(action, sendingJson, (json, onProgress) => answerFrom(progressed(json), onProgress))
    : checkedStream(action, sendingJson, (json, onProgress) =>
        elementsFrom(progressed(json), onProgress),
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
 * - A native rpc of the binding's `rpcs` is the native client's method: a stream rpc's is a `Stream`, its headers given as its options' `headers`, since `RpcClient.withHeaders` wraps an Effect.
 */
export function client<const B extends Any>(
  binding: B,
  options?: ClientOptions,
): Effect.Effect<
  Client<B>,
  never,
  RpcClient.Protocol | Scope.Scope | Rpc.MiddlewareClient<RpcGroup.Rpcs<B["rpcs"]>>
>;
export function client(
  binding: Any,
  options?: ClientOptions,
): Effect.Effect<object, never, RpcClient.Protocol | Scope.Scope> {
  const byName = new Map(binding.actions.map((action) => [action.name, action]));

  return Effect.map(
    RpcClient.make(erasedOf(binding.actions).merge(nativeOf(binding.rpcs)), options),
    (native) =>
      Object.fromEntries(
        Object.entries(native).map(([tag, method]) => {
          const action = byName.get(tag);

          return [tag, action === undefined ? method : actionMethodOf(action, binding, method)];
        }),
      ),
  );
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
export const reconnectUntil = (...codes: ReadonlyArray<number>) =>
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
        ),
    ),
  );
