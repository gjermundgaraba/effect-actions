import {
  Cause,
  type Context,
  Effect,
  ErrorReporter,
  Layer,
  Predicate,
  Result,
  Schedule,
  Schema,
  type Scope,
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
  RpcSerialization,
  RpcServer,
} from "effect/rpc";
import type * as Action from "../contract/Action.js";
import { Anyone } from "../contract/caller.js";
import { type Certain, type ErrorsOf, bindingErrors, bindingOf } from "../contract/declared.js";
import {
  type Any as Authentication,
  type Credential,
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
import { type Call, checked, decodeInput, type ErasedMethod } from "../contract/call.js";
import { type BuiltIn, type BuiltIns, Unauthenticated } from "../contract/errors.js";
import {
  acquire,
  type BuildError,
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
  servingOf,
} from "../contract/implementation.js";

type BindingError = Action.Errors[number];

type ErrorOf<A extends Action.Any, E extends Action.Errors, D> = Schema.Union<
  ReadonlyArray<A["error"][number] | E[number] | VerifierError<A, D> | BuiltIns>
>;

type RpcOf<A extends Action.Any, E extends Action.Errors, D> = A extends Action.Any
  ? Rpc.Rpc<A["name"], A["input"], A["success"], ErrorOf<A, E, D>>
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
   * The native group of one rpc per action, named after it, and of `rpcs`, as clients see it:
   * `RpcClient.make(Rpc.group)` is the native client.
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
   * Native rpcs the binding serves beside its actions, with their own schemas and handlers,
   * such as one that streams: `RpcGroup.make(Watch)`. Under an `authentication`, each of their
   * messages authenticates as a protected action's does: its handler reads the identity, and a
   * refusal fails the call with `Unauthenticated`.
   *
   * **Gotchas**
   *
   * - `layer` requires their handlers, which the host provides from the binding's own `rpcs`: `Rpc.rpcs.toLayer(handlers)`, whose types then leave the identity unowed.
   * - A native rpc runs no implementation's `authorize`: its handler authorizes the identity itself, as an action's `authorize` would, or every authenticated caller is served.
   * - The layer's `middleware` runs on actions alone: a native rpc runs the native middleware its group adds, inside its authentication.
   * - Serve `rpcs` as the binding holds them: `layer` refuses a protected binding whose native rpc does not run its authentication outermost, such as one added with `rpcs.add` after `make`; add rpcs and middleware to the group given here.
   * - A native rpc named after one of the actions is refused as the binding is made.
   */
  readonly rpcs?: RpcGroup.Any;
}

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Native group boundary: every native group is a `RpcGroup` of native rpcs, each carrying its schemas and middleware; only its invariant static rpcs are dropped.
const nativeOf = (group: RpcGroup.Any) => group as RpcGroup.RpcGroup<Rpc.AnyWithProps>;

type RpcsOf<O> = O extends { readonly rpcs: infer G } ? RpcGroup.Rpcs<G> : never;

// Why: a native rpc's refusal is its own call's typed failure, as an action's is: the
// middleware's error joins the rpc's in the exit both sides encode, so its client decodes
// `Unauthenticated` and the verifier's errors without declaring them. Its key is one name, which
// `layer` provides each server its own implementation under.
const authenticatedOf = (authentication: Authentication) =>
  RpcMiddleware.Service<Authenticated<unknown>, { provides: unknown }>()(authenticatedKey, {
    error: Schema.Union([Unauthenticated, ...authentication.error]),
  });

// Why: The same three overloads as `ActionHttp.make`, for the reasons stated there.
/**
 * Bind actions once, for servers and clients alike, each as an rpc named after it, taking
 * its action's input and answering its success. Every rpc declares its action's errors, the
 * binding's `error`, and the built-in `InvalidInput`, `Unauthenticated` and `Forbidden`, so
 * clients decode each as a typed failure; a protected one also declares what its descriptor's
 * verifier fails with. An action's rpc is unary; `rpcs` adds native ones beside them, such as
 * one that streams. Browser-safe, as an HTTP binding is.
 * Guide: `docs/ActionRpc.md` in this package; in an application: `examples/live-rpc/`.
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

  const given = options.rpcs === undefined ? RpcGroup.make() : nativeOf(options.rpcs);

  for (const tag of given.requests.keys()) {
    if (actions.some((action) => action.name === tag)) {
      throw new Error(
        `ActionRpc binding: the rpc "${tag}" of rpcs is named after an action (rename one)`,
      );
    }
  }

  const rpcs =
    bound.authentication === undefined
      ? given
      : given.middleware(authenticatedOf(bound.authentication));

  const group = RpcGroup.make(
    ...actions.map((action) =>
      Rpc.make(action.name, {
        payload: action.input,
        success: action.success,
        error: Schema.Union(bindingErrors(action, bound)),
      }),
    ),
  ).merge(rpcs);

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

// Why: Unlike `ActionHttp`'s, this does not exclude `HttpRouter.Provided`. An rpc has an HTTP
// request only over a router-mounted protocol, where `HttpRouter.serve` provides it; stdio, a
// socket or a worker has none, so a handler reading one must leave it owed there.
type LayerRequest<App, A extends Action.Any, M extends Middleware> = Exclude<
  Through<M, RemoteRequest<App, A>>,
  [Extract<Serving<App, A>, { readonly caller: typeof Anyone }>] extends [never]
    ? Identity<Protected<Serving<App, A>>>
    : never
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
   */
  readonly middleware?: M;
}

const credentialFromRpcHeaders = (
  security: Authentication["security"],
  headers: Headers.Headers,
): Effect.Effect<Credential> =>
  HttpApiBuilder.securityDecode(security).pipe(
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

const authenticatorOf = (authentication: Authentication) =>
  Effect.map(providerOf(authentication), (provider) => ({
    authentication,
    verify: (headers: Headers.Headers) =>
      Effect.flatMap(
        credentialFromRpcHeaders(authentication.security, headers),
        provider.authenticate,
      ),
  }));

class InternalError extends Error {
  override readonly [ErrorReporter.ignore] = true;

  constructor() {
    super("Internal server error");
  }
}

// Why: A declared failure is the caller's answer, which no error reporter is given. The mark
// that says so is on this wrapper, which the server's group encodes to the JSON it holds, and
// never on the JSON: a mark on the failure touches a value the handler made, and a primitive
// takes none. It prints as its JSON, which is what a trace of the server's span shows.
class DeclaredFailure {
  readonly [ErrorReporter.ignore] = true;

  constructor(readonly json: Schema.Json) {}

  toString() {
    return Predicate.isString(this.json) ? this.json : JSON.stringify(this.json);
  }
}

const DeclaredFromJson = Schema.Json.pipe(
  Schema.decodeTo(
    Schema.instanceOf(DeclaredFailure),
    SchemaTransformation.transform({
      decode: (json) => new DeclaredFailure(json),
      encode: (failure) => failure.json,
    }),
  ),
);

const internal = (cause: Cause.Cause<unknown>) =>
  Effect.logError(cause).pipe(
    Effect.andThen(ErrorReporter.report(cause)),
    Effect.andThen(Effect.die(new InternalError())),
  );

const callBoundaryOf = (error: Schema.Union<Action.Errors>) => {
  const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(error));

  return <A, R>(effect: Effect.Effect<A, unknown, R>): Effect.Effect<A, unknown, R> =>
    Effect.catchCause(effect, (cause) => {
      if (Cause.hasDies(cause)) return internal(cause);

      const failure = Cause.findFail(cause);

      return Result.isSuccess(failure)
        ? encode(failure.success.error).pipe(
            Effect.matchCauseEffect({
              onFailure: (unencoded) => internal(Cause.combine(cause, unencoded)),
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

    // Why: The steps run here, each suspended, and none as native rpc middleware. Effect applies
    // native middleware as it sets a call up, outside any Effect, so one that throws fails the
    // whole connection; suspended, a throw is its own call's defect.
    const wrapped = steps.reduce<Effect.Effect<unknown, unknown, unknown>>(
      (inner, step) => Effect.suspend(() => step(inner, { ...options, payload })),
      call,
    );

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased call boundary: the steps pass the call's encoded success through, or fail; the boundary fails with a declared failure in its wrapper alone, or an interruption.
    return boundary(wrapped) as Effect.Effect<Schema.Json, DeclaredFailure, unknown>;
  };
};

const jsonProbe: Schema.Json = { probe: [1, "a", null, true] };

// Why: an action is a JSON contract on every surface, so its values cross as JSON whatever the
// protocol's own codec: a protocol passing values, such as a Durable Object stub's, carries them
// as they are, unencoded twice, and one whose codec encodes JSON otherwise, as schema-binary's
// makes bytes the framing would not hold, is refused.
const carryingJson = <P extends { readonly codecFor: RpcSerialization.CodecFor }>(protocol: P) =>
  Effect.try(() => Schema.encodeSync(protocol.codecFor(Schema.Json))(jsonProbe)).pipe(
    Effect.map((encoded) => JSON.stringify(encoded) === JSON.stringify(jsonProbe)),
    Effect.orElseSucceed(() => false),
    Effect.flatMap((carries) =>
      carries
        ? Effect.succeed({ ...protocol, codecFor: RpcSerialization.json.codecFor })
        : Effect.die(
            new Error(
              "ActionRpc puts JSON in a protocol's messages, which this protocol's codec does not keep as it is (provide RpcSerialization.layerJson, layerNdjson, layerJsonRpc or layerNdJsonRpc, or a protocol passing values)",
            ),
          ),
    ),
  );

/**
 * Serve the binding's actions among `implementations` with Effect's own `RpcServer`, or those
 * its `actions` lists, as `ActionHttp.layer` selects them, under the protocol and JSON
 * serialization the host provides. Each message of a protected rpc authenticates from its own
 * headers with the binding's descriptor; then the listed `middleware` runs, the input decodes,
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
 * - Over a protocol with no router, such as `RpcServer.layerProtocolSocketServer` or `layerProtocolStdio`, there is no HTTP request or route: a provider publishing a `protectedResource` leaves `HttpRouter` owed, and a verifier yielding a request service leaves it owed.
 * - A protocol passing values, such as a Durable Object stub's, serves too: the actions' values cross as JSON whatever its codec, which the layer replaces with JSON's.
 * - A codec that does not keep a JSON value as it is, such as schema-binary's, fails the build with `ActionRpc puts JSON in a protocol's messages`, naming the codecs to provide.
 * - The binding's native `rpcs` are served on the same protocol with their own schemas, every one, whatever `actions` lists, and their handlers are owed until provided: `Rpc.rpcs.toLayer(handlers)`; a native rpc's defect or undeclared failure is answered as Effect's server answers it, never `Internal server error`, and only its verifier's defect is.
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
  const { apps, actions, authentication } = servingOf("RPC binding", binding, served, options);

  const middleware = options.middleware ?? [];

  const natives = nativeOf(binding.rpcs);

  // Why: native authentication is the binding's, whatever `actions` selects, since every native
  // rpc is served; its middleware's implementation is always this layer's own, provided beneath
  // the server, so no Layer of the host's under its key reaches it.
  const nativeAuthentication = natives.requests.size === 0 ? undefined : binding.authentication;

  const jsonGroup = RpcGroup.make(
    ...actions.map((action) =>
      Rpc.make(action.name, {
        payload: Schema.Json,
        success: Schema.Json,
        error: DeclaredFromJson,
      }),
    ),
  );

  const handlers = Layer.unwrap(
    Effect.gen(function* () {
      if (nativeAuthentication !== undefined) {
        for (const rpc of natives.requests.values()) {
          if ([...rpc.middlewares].at(-1)?.key !== authenticatedKey) {
            return yield* Effect.die(
              new Error(
                `ActionRpc.layer: the native rpc ${rpc._tag} of a protected binding does not run its authentication outermost: serve the rpcs the binding ActionRpc.make returned holds, adding rpcs and middleware to the group given as its rpcs`,
              ),
            );
          }
        }
      }

      const listedMiddleware: ReadonlyArray<Step> = yield* Effect.forEach(middleware, (key) =>
        Effect.service(key),
      );

      const descriptor = authentication ?? nativeAuthentication;

      const authenticator =
        descriptor === undefined ? undefined : yield* authenticatorOf(descriptor);

      const bound = yield* acquire(apps);

      const byName = Object.fromEntries(
        bound.map(([action, run]) => {
          const steps: ReadonlyArray<Step> =
            action.caller === Anyone || authenticator === undefined
              ? listedMiddleware
              : [
                  ...listedMiddleware,
                  (effect, { headers }) =>
                    Effect.flatMap(authenticator.verify(headers), (actor) =>
                      Effect.provideService(effect, authenticator.authentication.identity, actor),
                    ),
                ];

          return [
            action.name,
            handlerOf(action, run, steps, Schema.Union(bindingErrors(action, binding))),
          ] as const;
        }),
      );

      const served = jsonGroup.toLayer(byName);

      if (natives.requests.size === 0 || authenticator === undefined) return served;

      // Why: a verifier's defect is masked as on an action, `Internal server error` with its
      // cause reported: Effect's server would answer a native rpc's defect with its message and
      // cause, and the authentication step is the library's, not the host's handler.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased middleware: the step passes the call's success through, or fails with a refusal or the verifier's error, which the middleware declares, and provides the identity it declares.
      const authenticated = ((effect, { headers }) =>
        Effect.suspend(() => authenticator.verify(headers)).pipe(
          Effect.catchCause((cause) =>
            Cause.hasDies(cause) ? internal(cause) : Effect.failCause(cause),
          ),
          Effect.flatMap((actor) =>
            Effect.provideService(effect, authenticator.authentication.identity, actor),
          ),
        )) as RpcMiddleware.RpcMiddleware<unknown, unknown, never>;

      return Layer.merge(
        served,
        Layer.succeed(authenticatedOf(authenticator.authentication))(authenticated),
      );
    }),
  ).pipe(provideHandlers(apps));

  return RpcServer.layer(jsonGroup.merge(binding.rpcs), { disableFatalDefects: true }).pipe(
    Layer.provide(handlers),
    Layer.provide(
      Layer.effect(RpcServer.Protocol)(Effect.flatMap(RpcServer.Protocol, carryingJson)),
    ),
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
  Effect.Effect<A["success"]["Type"], MethodError<A, E>>
>;

/**
 * Every action of the binding `B`, as `client.<action>(input)`: a protected one may also fail
 * with what its descriptor's verifier declares.
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

type ClientRpc = Rpc.Rpc<string, Action.Any["input"], Action.Any["success"], BindingError>;

type NativeMethod = (payload: ErasedValue) => Effect.Effect<ErasedValue, unknown>;

type NativeClient = { readonly [name: string]: NativeMethod | undefined };

/**
 * Effect's native `RpcClient` for a binding, one method per action taking the action's input
 * directly: `client.greet({ name })`, as `ActionHttp.client`'s, the argument omitted when `{}`
 * is a valid input, each call failing with its `MethodError`. Requires the native client
 * `Protocol` and a `Scope`, as `RpcClient.make` does; headers set with `RpcClient.withHeaders`
 * around a call go with its message. The native client stays available:
 * `RpcClient.make(Rpc.group)`.
 *
 * **Gotchas**
 *
 * - It drops undeclared input fields as it encodes, and fails with `InvalidInput`, sending nothing, for an input that does not encode.
 * - A browser WebSocket cannot set an `Authorization` header on its upgrade, so under Bearer a protected call without its own token fails with `Unauthenticated`, `A bearer token is required.`: send the token on each call with `RpcClient.withHeaders`.
 * - The socket belongs to the Layer providing the protocol, not to the `Scope` around the client: provided around one call, it opens a socket for that call alone.
 * - The actions' values cross as JSON whatever the protocol's codec, as `layer` serves them: a codec that does not keep a JSON value as it is, such as schema-binary's, is refused as the client is made, with `ActionRpc puts JSON in a protocol's messages`.
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
): Effect.Effect<
  { readonly [name: string]: ErasedMethod | NativeMethod },
  never,
  RpcClient.Protocol | Scope.Scope
> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Native group boundary: every binding's group is a native group `make` built, one rpc per action, each taking its action's input; only its invariant static rpcs are dropped.
  const group = binding.group as RpcGroup.RpcGroup<ClientRpc>;

  const made = RpcClient.make(group, options).pipe(
    Effect.provideServiceEffect(
      RpcClient.Protocol,
      Effect.flatMap(Effect.service(RpcClient.Protocol), carryingJson),
    ),
  );

  return Effect.map(made, (client) => {
    const native: NativeClient = client;

    const methodOf = (name: string) => {
      const method = native[name];

      if (method === undefined)
        throw new Error(
          `No client method for ${name} (use the binding \`ActionRpc.make\` returned, whose group holds this rpc)`,
        );

      return method;
    };

    return Object.fromEntries([
      ...binding.actions.map((action) => {
        const method = methodOf(action.name);

        return [action.name, checked(action, (payload) => method(payload))] as const;
      }),
      ...[...nativeOf(binding.rpcs).requests.keys()].map((tag) => [tag, methodOf(tag)] as const),
    ]);
  });
}

/**
 * A socket client's `retryPolicy`, for `RpcClient.layerProtocolSocket`, that stops connecting
 * again once the server closes the socket with one of `codes`: until then it is Effect's own
 * default, `Schedule.min([Schedule.exponential(500, 1.5), Schedule.spaced(5000)])`, which Effect
 * does not export. The client half of the Cloudflare package's
 * `ActionDurableObject.refuseUpgrade`: a page refused with its code stops, its calls and streams
 * failing with that `SocketCloseError`.
 *
 * **Gotchas**
 *
 * - A client without it connects again after a refusal as after any close, every five seconds for good, and each upgrade wakes a Durable Object that refuses it again.
 * - Any other socket error, a drop included, is retried as Effect's default retries it.
 */
export const reconnectUntil = (...codes: ReadonlyArray<number>) =>
  Schedule.min([Schedule.exponential(500, 1.5), Schedule.spaced(5000)]).pipe(
    // Why: typed by the one field it reads rather than as Effect's `SocketError`, so a browser
    // client importing this module needs no `effect/socket`; a `SocketError` is one.
    Schedule.setInputType<{ readonly reason: unknown }>(),
    Schedule.while(({ input: { reason } }) => {
      const closedWith =
        Predicate.isTagged(reason, "SocketCloseError") && Predicate.hasProperty(reason, "code")
          ? reason.code
          : undefined;

      return !codes.some((code) => code === closedWith);
    }),
  );
