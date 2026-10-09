import {
  Cause,
  type Context,
  Effect,
  ErrorReporter,
  Layer,
  Predicate,
  Result,
  Schema,
  type Scope,
  type Types,
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
import type * as Action from "./Action.js";
import {
  Anyone,
  assertDistinct,
  assertOnce,
  assertOwnTags,
  errorList,
  projectedErrors,
} from "./internal/actions.js";
import {
  assertAuthentication,
  type Any as Authentication,
  type Credential,
  type DescriptorOf,
  type Identity,
  type Matching,
  providerOf,
  type PublicOnly,
  type RemoteRequest,
  type Required as RequiredAuthentication,
  type ServedProvider,
  type VerifierError,
} from "./internal/authentication.js";
import { type Call, checked, type ErasedMethod } from "./internal/call.js";
import type { Certain, ErrorsOf } from "./internal/declared.js";
import { type BuiltIn, type BuiltIns, InvalidInput } from "./internal/errors.js";
import {
  acquire,
  type BuildError,
  type BuildServices,
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
  servedBy,
  type Serving,
  toList,
} from "./internal/implementation.js";

/** An error schema the binding declares on every rpc. */
type BindingError = Action.Errors[number];

/**
 * The errors the rpc of an action `A` declares, beside the binding's errors `E`: its own, the
 * built-in ones, and, for a protected action, what the descriptor `D`'s verifier fails with.
 */
type ErrorOf<A extends Action.Any, E extends Action.Errors, D> = Schema.Union<
  ReadonlyArray<A["error"][number] | E[number] | VerifierError<A, D> | BuiltIns>
>;

/** The native rpc of each action of `A`, as a binding's clients see it. */
type RpcOf<A extends Action.Any, E extends Action.Errors, D> = A extends Action.Any
  ? Rpc.Rpc<A["name"], A["input"], A["success"], ErrorOf<A, E, D>>
  : never;

/**
 * An RPC binding: actions, the errors every rpc declares, and the descriptor authenticating
 * its protected ones. Plain data, so a copy of it, or one made by another installed copy of
 * this package, serves the same; `layer` serves it and `client` calls it.
 */
export interface Binding<
  Actions extends ReadonlyArray<Action.Any>,
  E extends Action.Errors = [],
  D extends Authentication | undefined = undefined,
> {
  readonly authentication: D;
  /** The exact actions bound to this binding. */
  readonly actions: Actions;
  /** The errors every rpc declares besides its action's own, as a list. */
  readonly error: E;
  /**
   * The native group of one rpc per action, named after it, as clients see it:
   * `RpcClient.make(Rpc.group)` is the native client.
   */
  readonly group: RpcGroup.RpcGroup<RpcOf<Actions[number], E, D>>;
}

/**
 * Any RPC binding. Its group is any native group here, since native groups are invariant in
 * their rpcs; `actions` carries the types.
 */
export interface Any {
  readonly authentication?: Authentication | undefined;
  readonly actions: ReadonlyArray<Action.Any>;
  readonly error: Action.Errors;
  readonly group: RpcGroup.Any;
}

/** Contract-level configuration shared by servers and clients. */
export interface Options<E extends Action.Errors = Action.Errors> {
  /** Layer middleware's errors, which every rpc declares: one schema, or a list. */
  readonly error?: E | E[number];
  readonly authentication?: Authentication;
}

/**
 * What the rpc of `action` declares: its action's errors, the binding's and the built-in ones,
 * and for a protected action its descriptor's verifier's, as `make` declares them and `layer`
 * serves them.
 */
const errorsOf = (
  action: Action.Any,
  errors: Action.Errors,
  authentication: Authentication | undefined,
): Action.Errors =>
  projectedErrors(
    action,
    action.caller === Anyone || authentication === undefined
      ? errors
      : [...errors, ...authentication.error],
  );

/**
 * Bind actions once, for servers and clients alike, each as an rpc named after it, taking
 * its action's input and answering its success. Every rpc declares its action's errors, the
 * binding's `error`, and the built-in `InvalidInput`, `Unauthenticated` and `Forbidden`, so
 * clients decode each as a typed failure; a protected one also declares what its descriptor's
 * verifier fails with. Browser-safe, as an HTTP binding is.
 */
// Overloads as `ActionHttp.make`'s, for the same reasons: a `const` tuple of errors, and a
// protected action without options told to name its authentication.
export function make<
  const Actions extends ReadonlyArray<Action.Any & { readonly caller: typeof Anyone }>,
>(actions: Actions): Binding<Actions, [], undefined>;
export function make<const Actions extends ReadonlyArray<Action.Any>, const O extends Options = {}>(
  actions: Actions,
  options: O &
    RequiredAuthentication<Actions[number]> &
    Matching<Actions[number], NoInfer<DescriptorOf<O>>> &
    NoInfer<Known<O, Options>>,
): Binding<Actions, ErrorsOf<O>, DescriptorOf<O>>;
export function make<const Actions extends ReadonlyArray<Action.Any>>(
  actions: Actions & PublicOnly<Actions>,
): Binding<Actions, [], undefined>;
export function make(actions: ReadonlyArray<Action.Any>, options: Options = {}): Any {
  assertOnce("action", actions);

  const errors = errorList(options.error);

  assertOwnTags("ActionRpc binding", errors);

  assertAuthentication(actions, options.authentication);

  const group = RpcGroup.make(
    ...actions.map((action) =>
      Rpc.make(action.name, {
        payload: action.input,
        success: action.success,
        error: Schema.Union(errorsOf(action, errors, options.authentication)),
      }),
    ),
  );

  return { actions, error: errors, group, authentication: options.authentication };
}

/** Native rpc middleware, as `RpcMiddleware.Service` declares it. */
type Middleware = ReadonlyArray<RpcMiddleware.AnyService>;

/** The identifier a middleware's service key declares. */
type IdOf<K> = K extends Context.Key<infer I extends RpcMiddleware.AnyId, unknown> ? I : never;

/**
 * What the request owes past the middleware `M`, the first innermost, around what `R` owes:
 * each removes what it provides and adds what it requires, as native rpcs apply them. An
 * array of unknown length, which may hold none of them, provides nothing and owes what any of
 * them requires; so does a slot that may hold one of several, as only one runs.
 */
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

/** The middleware of `K` that may need a client counterpart. */
type ForClient<K> = K extends { readonly requiredForClient: infer F }
  ? true extends F
    ? K
    : never
  : never;

/**
 * The layer's middleware, refused when one fails with an error neither the binding, `E`, nor
 * every rpc declares, or needs a client counterpart: neither reaches the binding's clients,
 * whose group carries no middleware and decodes only what the binding and the built-ins
 * declare. A failure an action's callers see after decoding is its handler's, declared on the
 * contract and decoded by every client.
 */
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

/**
 * What the layer serving `A` of `App` behind middleware `M` owes per request, as router
 * request markers: the request context of a router-mounted protocol's route provides them,
 * and so does `M`, never a startup service. Unlike HTTP's, they keep `HttpRouter.Provided`:
 * `HttpRouter.serve` provides the request itself, and stdio, a socket or a worker has none.
 */
type LayerRequest<App, A extends Action.Any, M extends Middleware> = Exclude<
  Through<M, RemoteRequest<App, A>>,
  // Authentication, outermost, provides the identity, though only to protected rpcs.
  [Extract<Serving<App, A>, { readonly caller: typeof Anyone }>] extends [never]
    ? Identity<Protected<Serving<App, A>>>
    : never
>;

/**
 * The layer serving the actions `A` of `Apps` through the binding `B`, behind the middleware
 * `M`: an implementation holding none of them is not built.
 */
type RpcLayer<
  B extends Any,
  Apps extends Served,
  M extends Middleware,
  A extends Action.Any = B["actions"][number],
> = Layer.Layer<
  never,
  BuildError<Holding<Member<Apps>, A>, A>,
  | BuildServices<Holding<Member<Apps>, A>, A>
  | RpcServer.Protocol
  | HttpRouter.Request.From<"Requires", LayerRequest<Member<Apps>, A, M>>
  | ServedProvider<Member<Apps>, A, B extends { readonly authentication: infer D } ? D : never>
  | IdOf<M[number]>
>;

/** `ActionRpc.layer`'s options. */
export interface LayerOptions<M extends Middleware = [], A extends Action.Any = never> {
  /**
   * The actions it serves, among the binding's actions the implementations hold: `[GetUser]`.
   * Defaults to every one of them. A layer whose middleware requires the identity lists
   * protected actions only.
   */
  readonly actions?: ReadonlyArray<A> | undefined;
  /**
   * Native rpc middleware every served rpc runs, the first innermost: inside the
   * authentication of a protected rpc, outside its decoding. Server-only: the binding's group,
   * which clients use, carries none. A middleware requiring the identity needs a layer
   * serving only protected actions.
   */
  readonly middleware?: M;
}

/**
 * The credential `security` decodes from an rpc's headers, as the native security middleware
 * decodes it from a request's: an HTTP request's headers merged with the message's over HTTP,
 * the upgrade request's merged with each message's over a WebSocket. A query parameter is never
 * among them.
 */
const credentialOf = (
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

/** What a native rpc middleware is handed with the call it wraps. */
type CallOptions = Parameters<RpcMiddleware.RpcMiddleware<never, never, never>>[1];

/** A step of a served call around the steps it wraps: its authentication, or a middleware. */
type Step = (
  effect: Effect.Effect<unknown, unknown, unknown>,
  options: CallOptions,
) => Effect.Effect<unknown, unknown, unknown>;

/**
 * The step authenticating a protected rpc, per message: the credential its headers carry,
 * verified by the descriptor's provider, the identity provided to what it wraps. The
 * verifier's request services are restored by `Authentication.layer`'s signature as router
 * request markers, which only the route of a router-mounted protocol provides.
 */
const authenticationOf = (authentication: Authentication) =>
  Effect.map(
    providerOf(authentication),
    (provider): Step =>
      (effect, { headers }) =>
        credentialOf(authentication.security, headers).pipe(
          Effect.flatMap(provider.authenticate),
          Effect.flatMap((actor) => Effect.provideService(effect, authentication.identity, actor)),
        ),
  );

/**
 * What a call answers in place of anything its rpc does not declare: a defect whose message
 * is all the caller learns. Effect's reporters skip it, as the cause it replaces is reported.
 */
class InternalError extends Error {
  override readonly [ErrorReporter.ignore] = true;

  constructor() {
    super("Internal server error");
  }
}

/**
 * A declared failure's JSON, as its call fails with it: marked `ErrorReporter.ignore`, not
 * enumerable so never sent, as Effect's server reports every failed call, and a declared
 * failure is the caller's answer, never an incident, as over HTTP.
 */
const answered = (encoded: Schema.Json): Schema.Json => {
  if (Predicate.isObject(encoded)) {
    Object.defineProperty(encoded, ErrorReporter.ignore, { value: true });
  }

  return encoded;
};

/**
 * The boundary of each served call of an rpc declaring `error`. A failure is encoded here as
 * one, so what is checked is what is sent, and only the first: one answer carries one error,
 * as an HTTP response does. An interruption propagates. Anything else, a defect of the
 * verifier, of a middleware or of the handler, an undeclared failure or one that does not
 * encode, or a success that does not, is logged with its cause, reported to the call's
 * `ErrorReporter`s, and answered as that request's `InternalError`, as MCP answers it: the
 * native server would send the cause's message to the caller.
 */
const boundaryOf = (error: Schema.Union<Action.Errors>) => {
  const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(error));

  const internal = (cause: Cause.Cause<unknown>) =>
    Effect.logError(cause).pipe(
      Effect.andThen(ErrorReporter.report(cause)),
      Effect.andThen(Effect.die(new InternalError())),
    );

  return <A, R>(effect: Effect.Effect<A, unknown, R>): Effect.Effect<A, unknown, R> =>
    Effect.catchCause(effect, (cause) => {
      if (Cause.hasDies(cause)) return internal(cause);

      const failure = Cause.findFail(cause);

      return Result.isSuccess(failure)
        ? encode(failure.success.error).pipe(
            Effect.matchCauseEffect({
              onFailure: (unencoded) => internal(Cause.combine(cause, unencoded)),
              onSuccess: (encoded) => Effect.fail(answered(encoded)),
            }),
          )
        : Effect.failCause(cause);
    });
};

/**
 * The native handler of `action`, its rpc declaring `error`: the `steps` around it, the first
 * innermost, then its JSON payload decoded, a failure answering `InvalidInput`, then `run`, its
 * dispatch, then its success encoded, all inside the boundary. Each step runs as the call does,
 * never as the native server sets the call up, so one that throws fails that call alone, and
 * the payload is decoded once the steps around it let it through.
 */
const handlerOf = (
  action: Action.Any,
  run: ErasedHandler<unknown>,
  steps: ReadonlyArray<Step>,
  error: Schema.Union<Action.Errors>,
) => {
  // Strict, as HTTP decodes: an undeclared field is refused, not dropped.
  const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(action.input), {
    errors: "all",
    onExcessProperty: "error",
  });

  const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(action.success));
  const boundary = boundaryOf(error);

  return (payload: Schema.Json, options: Omit<CallOptions, "payload">) => {
    const call = Effect.suspend(() => decode(payload)).pipe(
      Effect.mapError(InvalidInput.fromSchemaError),
      Effect.flatMap(run),
      Effect.flatMap(encode),
    );

    const wrapped = steps.reduce<Effect.Effect<unknown, unknown, unknown>>(
      (inner, step) => Effect.suspend(() => step(inner, { ...options, payload })),
      call,
    );

    // SAFETY: the steps pass the call's encoded success through, or fail; the boundary fails
    // with an encoded error alone, or an interruption.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased call boundary.
    return boundary(wrapped) as Effect.Effect<Schema.Json, Schema.Json, unknown>;
  };
};

/**
 * Serve the binding's actions among `implementations` with Effect's own `RpcServer`, or those
 * its `actions` lists, as `ActionHttp.layer` selects them. The host provides the protocol,
 * such as `RpcServer.layerProtocolWebsocket` or `layerProtocolHttp` and its JSON serialization:
 * the layer refuses to build under a protocol that does not speak JSON. A protected rpc
 * authenticates each message from its headers with the binding's descriptor, outermost; then
 * the layer's `middleware` runs, then the input is decoded, a failure answering `InvalidInput`,
 * then the implementation's `authorize` and the handler, as on every surface.
 *
 * The server serves its own copy of the binding's group, whose payloads, successes and errors
 * are the actions' JSON and which carries no native middleware: the protocol decodes a payload before
 * any middleware runs, and answers one that does not decode with a defect, so each handler
 * runs the authentication and the middleware itself, then decodes the input. A defect is
 * logged with its cause, reported to the call's `ErrorReporter`s, and answered as its
 * request's generic failure, never failing the connection's other calls; a declared failure is
 * the caller's answer, and never reported.
 *
 * The layer fails as the builders do, needs at startup what they need, and per request what
 * each implementation's authorization and the handlers of the actions it serves need, as
 * router request markers, until its `middleware` provides them: over a router-mounted
 * protocol, the route's request context does too. The identity of a protected action is
 * provided by its authentication alone.
 */
export function layer<const B extends Any, const Apps extends Served>(
  binding: B,
  implementations: Apps,
): RpcLayer<B, Apps, []>;
// Options apart, so the middleware or actions an options type names are never typed as
// installed or selected where the options are left out.
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
  const apps = servedBy("RPC binding", binding.actions, toList(served), options.actions);
  const actions = apps.flatMap((app) => app.actions);
  assertAuthentication(actions, binding.authentication);

  const middleware = options.middleware ?? [];
  // As over HTTP: a middleware listed twice would run twice.
  assertDistinct("middleware", middleware, (key) => key.key);

  const auth = actions.some((action) => action.caller !== Anyone)
    ? binding.authentication
    : undefined;

  // Every rpc's payload, success and error are JSON, which its handler decodes and encodes.
  const group = RpcGroup.make(
    ...actions.map((action) =>
      Rpc.make(action.name, { payload: Schema.Json, success: Schema.Json, error: Schema.Json }),
    ),
  );

  const handlers = Layer.unwrap(
    Effect.gen(function* () {
      const { codecFor } = yield* RpcServer.Protocol;

      // The handler decodes each payload once the steps around it let it through, so the
      // protocol must leave it readable without its schema: JSON. Another codec, such as
      // schema-binary's, writes a payload in its schema's own layout, which only that schema
      // reads, and the protocol reads it before any middleware runs.
      if (codecFor !== RpcSerialization.json.codecFor) {
        return yield* Effect.die(
          new Error(
            "ActionRpc serves a protocol speaking JSON: RpcSerialization.layerJson, layerNdjson, layerJsonRpc or layerNdJsonRpc, not another codec, such as schema-binary's",
          ),
        );
      }

      // Each key is a native rpc middleware's, so its service is the middleware.
      const listed: ReadonlyArray<Step> = yield* Effect.forEach(middleware, (key) =>
        Effect.service(key),
      );

      const authenticate = auth === undefined ? undefined : yield* authenticationOf(auth);
      const bound = yield* acquire(apps);

      // Own properties, so an action named `__proto__` is an rpc, not a prototype.
      const byName = Object.fromEntries(
        bound.map(
          ([action, run]) =>
            [
              action.name,
              handlerOf(
                action,
                run,
                action.caller === Anyone || authenticate === undefined
                  ? listed
                  : [...listed, authenticate],
                // What the rpc of `action` declares, as the binding's group declares it.
                Schema.Union(errorsOf(action, binding.error, binding.authentication)),
              ),
            ] as const,
        ),
      );

      return group.toLayer(byName);
    }),
  ).pipe(provideHandlers(apps));

  // A failure the boundary answers is a defect, which the native server would otherwise send
  // as the connection's, failing its other calls.
  return RpcServer.layer(group, { disableFatalDefects: true }).pipe(Layer.provide(handlers));
}

/**
 * What one call of an action `A` fails with, beside the binding's errors `E`: its declared and
 * built-in errors, and Effect's own `RpcClientError`. Input that does not encode is
 * `InvalidInput`, and nothing is sent; an answer that does not decode is a defect, as the
 * native client makes it.
 */
export type MethodError<A extends Action.Any, E extends BindingError = never> =
  | A["error"][number]["Type"]
  | E["Type"]
  | BuiltIns["Type"]
  | RpcClientError.RpcClientError;

/** One action as an Effect of its decoded success, failing with `MethodError`. */
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
};

/**
 * The native `RpcClient.make` options `client` takes: `spanPrefix`, `spanAttributes`,
 * `generateRequestId` and `disableTracing`. `flatten` changes the client's shape, which the
 * method types cannot follow.
 */
export type ClientOptions = Omit<NonNullable<Parameters<typeof RpcClient.make>[1]>, "flatten">;

/** The rpc of an action as a client sends it, erased: its schemas read no service. */
type ClientRpc = Rpc.Rpc<string, Action.Any["input"], Action.Any["success"], BindingError>;

/** A native client method, erased. */
type NativeMethod = (payload: ErasedValue) => Effect.Effect<ErasedValue, unknown>;

/** A native client, erased: one method per rpc of the group. */
type NativeClient = { readonly [name: string]: NativeMethod | undefined };

/**
 * Effect's native `RpcClient` for a binding, one method per action taking the action's input
 * directly: `client.greet({ name })`, as `ActionHttp.client`'s. The argument may be omitted
 * when `{}` is a valid input. Requires the native client `Protocol` and a `Scope`, as
 * `RpcClient.make` does; headers set with `RpcClient.withHeaders` around a call go with its
 * message. The native client itself stays available: `RpcClient.make(Rpc.group)`.
 *
 * A call fails with a declared error value (the action's own, the binding's, a built-in
 * `InvalidInput`, `Unauthenticated` or `Forbidden`, or on a protected rpc its descriptor's),
 * or with Effect's own `RpcClientError` when the server could not be reached.
 */
export function client<const B extends Any>(
  binding: B,
  options?: ClientOptions,
): Effect.Effect<Client<B>, never, RpcClient.Protocol | Scope.Scope>;
export function client(
  binding: Any,
  options?: ClientOptions,
): Effect.Effect<
  { readonly [name: string]: ErasedMethod },
  never,
  RpcClient.Protocol | Scope.Scope
> {
  // SAFETY: every binding's group is a native group `make` built, one rpc per action, each
  // taking its action's input; only its invariant static rpcs are dropped.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Native group boundary.
  const group = binding.group as RpcGroup.RpcGroup<ClientRpc>;

  return Effect.map(RpcClient.make(group, options), (client) => {
    const native: NativeClient = client;

    return Object.fromEntries(
      binding.actions.map((action) => {
        const method = native[action.name];

        if (method === undefined) throw new Error(`No client method for ${action.name}`);

        return [action.name, checked(action, (payload) => method(payload))];
      }),
    );
  });
}
