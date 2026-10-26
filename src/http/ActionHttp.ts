import {
  Context,
  Effect,
  type FileSystem,
  Layer,
  type Path,
  type Schema,
  Scope,
  type Types,
} from "effect";
import type { Etag, HttpClient, HttpClientError, HttpPlatform } from "effect/http";
import { FetchHttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  HttpApi,
  HttpApiBuilder,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  OpenApi,
} from "effect/http-api";
import type * as Action from "../contract/Action.js";
import type * as Event from "../contract/Event.js";
import { listed, type Only } from "../contract/listed.js";
import type { SubscriptionOf } from "../contract/push.js";
import { answering, eventEndpointOf, type pageOf, type sentOf, servedSent } from "./events.js";
import {
  acquireFeeds,
  type EventBuildError,
  type EventBuildServices,
  type EventServedRequest,
  type HoldingEvents,
  type ServingEvents,
  unkeyedHook,
} from "../contract/feed.js";
import {
  type Any as Authentication,
  type DescriptorOf,
  type LayerIdentity,
  type Matching,
  providerOf,
  type PublicOnly,
  type ServedProvider,
  type RemoteRequest,
  type Required as RequiredAuthentication,
  type ServerBuildServices,
  type VerifierError,
} from "../authentication/provider.js";
import { Anyone, type Called } from "../contract/caller.js";
import {
  type Certain,
  type ErrorsOf,
  projectedErrors,
  bindingErrors,
  bindingOf,
  eventErrors,
} from "../contract/declared.js";
import { declared } from "../contract/status.js";
import { inputParseOptions } from "../contract/call.js";
import { type AnyHttp, type Client, methods, type Options as ClientOptions } from "./client.js";
import type { BuiltIn, BuiltIns } from "../contract/errors.js";
import { SchemaErrors, schemaErrors } from "./schema-errors.js";
import {
  answeredWithProgress,
  answeringElements,
  answeringWithProgress,
  elementStreamOf,
  progressStreamOf,
  type SuccessOf,
} from "./streamed.js";
import { elementOf } from "../contract/stream.js";
import {
  acquire,
  type BuildError,
  type ErasedHandler,
  type ErasedValue,
  type Known,
  type Member,
  type MiddlewareOf,
  type Served,
  type Selected,
  type SelectedEvents,
  type Holding,
} from "../contract/implementation.js";
import { provideServed, servingOf } from "../contract/serving.js";

export type { Client } from "./client.js";

export type { MethodError, WatchError } from "./client.js";

export type { AnyHttp as Any } from "./client.js";

export type { Options as ClientOptions } from "./client.js";

/** What `fetchClient` takes: `client`'s options, and the `fetch` its calls send with. */
export interface FetchClientOptions<
  E = HttpClientError.HttpClientError,
  R = never,
> extends ClientOptions<E, R> {
  /**
   * What each call sends with. Omitted: the global `fetch`, looked up on every call, so one
   * installed after the client is built, such as a test's stub, is used.
   *
   * **Gotchas**
   *
   * - A page on the API's own origin sends its cookies already; from another origin pass `(input, init) => fetch(input, { ...init, credentials: "include" })`, and the server's CORS must allow credentials, `HttpRouter.cors({ allowedOrigins, credentials: true })`.
   * - A `fetch` of your own passes `init.signal` on, or interrupting a call no longer aborts its request: a deadline is `Effect.timeout` on the call.
   */
  readonly fetch?: typeof globalThis.fetch | undefined;
}

type Middleware = ReadonlyArray<Context.Key<HttpApiMiddleware.AnyId, unknown>>;

type IdOf<K> = K extends Context.Key<infer I extends HttpApiMiddleware.AnyId, unknown> ? I : never;

type Through<M extends Middleware, R> = number extends M["length"]
  ? R | HttpApiMiddleware.Requires<IdOf<M[number]>>
  : M extends readonly [infer K, ...infer Rest extends Middleware]
    ? Through<
        Rest,
        true extends Types.IsUnion<IdOf<K>>
          ? R | HttpApiMiddleware.Requires<IdOf<K>>
          : HttpApiMiddleware.ApplyServices<IdOf<K>, R>
      >
    : R;

type ServerOnly<M extends Middleware, E extends Action.Errors> = [
  | Exclude<
      HttpApiMiddleware.Error<IdOf<M[number]>>,
      Extract<Certain<E>, Action.Errors[number]>["Type"] | BuiltIn
    >
  | HttpApiMiddleware.MiddlewareClient<IdOf<M[number]>>,
] extends [never]
  ? unknown
  : {
      readonly "Layer middleware fails only with the binding's errors and needs no client": never;
    };

type HttpLayer<
  H extends AnyHttp,
  Apps extends Served,
  M extends Middleware,
  A extends Action.Any = H["actions"][number],
  E extends Event.Any = H["events"][number],
> = Layer.Layer<
  never,
  BuildError<Holding<Member<Apps>, A>, A> | EventBuildError<HoldingEvents<Member<Apps>, E>, E>,
  | ServerBuildServices<Holding<Member<Apps>, A>, A>
  | EventBuildServices<HoldingEvents<Member<Apps>, E>, E>
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<"Requires", LayerRequest<Member<Apps>, A, E, M>>
  | ServedProvider<
      Member<Apps>,
      A,
      H extends { readonly authentication: infer D } ? D : never,
      ServingEvents<Member<Apps>, E>
    >
  | IdOf<M[number]>
  | Etag.Generator
  | FileSystem.FileSystem
  | HttpPlatform.HttpPlatform
  | Path.Path
>;

/** `ActionHttp.layer`'s options. */
export interface LayerOptions<M extends Middleware = [], C extends Action.Any | Event.Any = never> {
  /**
   * The actions and event types it serves, among the binding's the implementations hold:
   * `[GetUser, UserRenamed]`, exactly those. Defaults to every one of them.
   *
   * **Gotchas**
   *
   * - A list naming actions alone serves no event type: each event route answers 404 until the event types are listed beside them; two layers of one binding given lists that overlap fail at startup with Effect's duplicate-route message.
   */
  readonly actions?: ReadonlyArray<C> | undefined;
  /**
   * Native endpoint middleware every served route runs, the first innermost: inside the
   * authentication of a protected route, outside its decoding, so it also sees invalid input.
   *
   * **Gotchas**
   *
   * - A middleware requiring the identity needs a layer serving only protected actions and event types: serve the public ones from a second layer without it.
   * - On a stream answering an action declaring `progress`, or one answering a stream, a middleware sees the call end at its first event, while its handler runs on, and never sees a later failure; what it provides lasts the handler.
   */
  readonly middleware?: M;
}

type LayerRequest<App, A extends Action.Any, E extends Event.Any, M extends Middleware> = Exclude<
  Through<M, RemoteRequest<App, A> | EventServedRequest<App, E>>,
  HttpRouter.Provided | LayerIdentity<App, A, E>
>;

/** Contract-level configuration shared by servers and clients. */
export interface Options<E extends Action.Errors = Action.Errors> {
  /**
   * The mount path of every route: `/api` by default, `/` at the root. Split a large API, or
   * actions sharing a name, into one binding per area, each with its own `prefix` and client;
   * one host serves them all.
   */
  readonly prefix?: `/${string}`;
  /**
   * What router middleware around the routes, or the layer's `middleware`, answers with, such as
   * a quota's 429, which every endpoint declares: one schema, or a list.
   *
   * **Gotchas**
   *
   * - An error a handler fails with goes in its action's `error`, not here.
   * - Router middleware answering with one encodes and sends it itself, `HttpServerResponse.schemaJson(QuotaExceeded)(error, { status: 429 })`, at the status `Action.Options.error` gives it: at any other a client fails with an `HttpClientError`.
   */
  readonly error?: E | E[number];
  /**
   * The descriptor of the binding's protected actions, `Authentication.make(...)`: required
   * when it holds one, and it documents and enforces their credentials as native endpoint
   * security middleware on each of them.
   *
   * **Gotchas**
   *
   * - One descriptor per binding: actions of a second identity take a second binding with its own `prefix`, and a public action may be in both.
   */
  readonly authentication?: Authentication;
}

type EndpointError<A extends Action.Any, E extends Action.Errors, D> = Schema.toCodecJson<
  A["error"][number] | E[number] | VerifierError<A, D> | BuiltIns
>;

type Endpoint<A extends Action.Any, E extends Action.Errors, D> = A extends Action.Any
  ? HttpApiEndpoint.HttpApiEndpoint<
      A["name"],
      "POST",
      `/${string}`,
      never,
      never,
      Schema.toCodecJson<A["input"]>,
      never,
      SuccessOf<A, EndpointError<A, E, D>>,
      EndpointError<A, E, D>,
      never
    >
  : never;

type EventEndpoint<V extends Event.Any, E extends Action.Errors, D> = V extends Event.Any
  ? HttpApiEndpoint.HttpApiEndpoint<
      V["name"],
      "POST",
      `/${string}`,
      never,
      never,
      Schema.toCodecJson<ReturnType<typeof SubscriptionOf<V>>>,
      never,
      Schema.toCodecJson<ReturnType<typeof pageOf<V>>> | ReturnType<typeof sentOf<V>>,
      Schema.toCodecJson<E[number] | VerifierError<V, D> | BuiltIns>,
      never
    >
  : never;

type Api<
  Actions extends ReadonlyArray<Action.Any>,
  E extends Action.Errors,
  D,
  Events extends ReadonlyArray<Event.Any>,
> = HttpApi.HttpApi<
  "actions",
  HttpApiGroup.HttpApiGroup<
    string,
    Endpoint<Actions[number], E, D> | EventEndpoint<Events[number], E, D>,
    true
  >
>;

/**
 * An HTTP binding: actions and event types, the errors every endpoint declares, and where they
 * are mounted. Plain data, so a copy of it, or one made by another installed copy of this
 * package, serves the same; `layer` serves it and `client` calls it.
 */
export interface Binding<
  Actions extends ReadonlyArray<Action.Any>,
  E extends Action.Errors = [],
  D extends Authentication | undefined = undefined,
  Events extends ReadonlyArray<Event.Any> = readonly [],
> {
  /** Its protected actions' authentication descriptor, or `undefined` without one. */
  readonly authentication: D;
  /** The exact actions bound to this binding. */
  readonly actions: Actions;
  /** The exact event types bound to this binding, each at `POST <prefix>/events/<name>`. */
  readonly events: Events;
  /** The errors every endpoint declares besides its action's own, as a list. */
  readonly error: E;
  /** Where its routes mount: `/api` by default, `/` at the root, without a trailing slash. */
  readonly prefix: `/${string}`;
  /**
   * The native `HttpApi`, for `OpenApi.fromApi`, `HttpApiSwagger.layer`, `HttpApiScalar.layer`
   * and Effect's own tools: it lists every action of the binding, served or not.
   *
   * **Gotchas**
   *
   * - Serve it with `layer`, never the native `HttpApiBuilder`: its group name is typed `string`, so `HttpApiBuilder.group(api, "api", …)` is refused as `Endpoint not handled: ${string}`, and given a `string`-typed name a protected action makes the host fail to build with `Service not found: effect-actions/Authentication/Security/…`.
   * - A header that middleware reads is not in its document, whose operations list no `parameters`: rewrite it, `OpenApi.fromApi(Http.api.annotate(OpenApi.Transform, (document) => …))`, or make the value an input.
   * - An OAuth protected resource is documented as a bearer scheme: Effect has no OAuth scheme.
   * - Combined into one document, `HttpApi.make("app").addHttpApi(A.api).addHttpApi(B.api)`, a shared action name makes `OpenApi.fromApi` throw `Duplicate OpenAPI operationId`, and a shared prefix silently drops one binding's actions from the document and a native client: otherwise document each alone.
   * - A binding holding no protected action documents no security scheme, so Swagger shows no Authorize button.
   */
  readonly api: Api<Actions, E, D, Events>;
}

interface Request {
  readonly payload: ErasedValue;
}

const mountSegments = (prefix: `/${string}` | undefined): ReadonlyArray<string> =>
  (prefix ?? "/api").split("/").filter((segment) => segment !== "");

const absolutePath = (segments: ReadonlyArray<string>): `/${string}` => `/${segments.join("/")}`;

const groupName = (mount: ReadonlyArray<string>): string => mount.join("/") || "/";

const apiOf = (group: string, endpoints: ReadonlyArray<HttpApiEndpoint.Constraint>) => {
  const empty = HttpApiGroup.make(group, { topLevel: true });
  const [first, ...rest] = endpoints;

  return HttpApi.make("actions")
    .annotate(HttpApi.ParseOptions, { errors: "all" })
    .add(first === undefined ? empty : empty.add(first, ...rest));
};

// Why: Every route is a POST, a `readOnly` action's included. A GET carries its input in the query
// string, where `HttpApi` takes only fields that encode to strings or arrays of strings, so a
// nested input or a number has no faithful form; and the caching a GET would buy only a public
// `readOnly` action gives up, as a protected route's answers are `no-store`.
const successOf = (action: Action.Any, errors: Action.Errors) => {
  const element = elementOf(action.success);

  if (element !== undefined) return elementStreamOf(element, action.progress, errors);

  return action.progress === undefined
    ? action.success
    : [
        answeredWithProgress(action.success),
        progressStreamOf(action.progress, action.success, errors),
      ];
};

const endpointOf = (action: Action.Any, path: `/${string}`, errors: Action.Errors) =>
  HttpApiEndpoint.post(action.name, path, {
    payload: action.input.pipe(HttpApiSchema.asJson()),
    success: successOf(action, errors),
    error: errors.map(declared),
  });

const answerOf = (action: Action.Any, run: ErasedHandler<unknown>) => {
  const element = elementOf(action.success);

  if (element !== undefined) return answeringElements(element, run);

  return action.progress === undefined ? run : answeringWithProgress(action.success, run);
};

/** A route a binding declares, of an action or an event type: a POST taking its body alone. */
type Route = HttpApiEndpoint.HttpApiEndpoint<
  string,
  "POST",
  `/${string}`,
  never,
  never,
  Schema.Top,
  never,
  Schema.Top,
  Schema.Top
>;

const withinLayerMiddleware = (endpoint: HttpApiEndpoint.Top, middleware: Middleware = []) =>
  middleware.reduce((inner, key) => inner.middleware(key), endpoint);

// Why: Two forms, actions alone or with options, not one whose options are a conditional rest
// parameter, as `OptionalUnless` gives: through one, TypeScript infers no `const` tuple of `error`,
// which `Certain` needs. The first takes public actions by its constraint, which a helper generic
// in them meets.
/**
 * Bind actions once, for servers and clients alike, each at `POST <prefix>/<action>`, a
 * `readOnly` one too, and event types, each at `POST <prefix>/events/<name>`. Every endpoint
 * declares its action's errors, the binding's `error`, and the built-in `InvalidInput`,
 * `Unauthenticated` and `Forbidden`, so clients decode each as a typed failure; a protected one
 * also declares what its descriptor's verifier fails with.
 * Guide: `docs/ActionHttp.md` in this package; in an application: `examples/notes-service/src/Api.ts`.
 *
 * **Gotchas**
 *
 * - An action and an event type of one name, or an event type listed twice, throw when `make` is called: they would share a client's method.
 */
export function make<
  const Contracts extends ReadonlyArray<
    (Action.Any | Event.Any) & { readonly caller: typeof Anyone }
  >,
>(
  contracts: Contracts,
): Binding<Only<Contracts, Action.Any>, [], undefined, Only<Contracts, Event.Any>>;
export function make<
  const Contracts extends ReadonlyArray<Action.Any | Event.Any>,
  const O extends Options = {},
>(
  contracts: Contracts,
  options: O &
    RequiredAuthentication<Contracts[number]> &
    Matching<Contracts[number], NoInfer<DescriptorOf<O>>> &
    NoInfer<Known<O, Options>>,
): Binding<Only<Contracts, Action.Any>, ErrorsOf<O>, DescriptorOf<O>, Only<Contracts, Event.Any>>;
// Why: Reached only when the forms above fail. TypeScript reports a call matching no overload by
// the last one's error, so this one tells protected actions without options to name their
// authentication, where the first form's constraint would tell them to be public.
export function make<const Contracts extends ReadonlyArray<Action.Any | Event.Any>>(
  contracts: Contracts & PublicOnly<Contracts>,
): Binding<Only<Contracts, Action.Any>, [], undefined, Only<Contracts, Event.Any>>;
export function make(
  contracts: ReadonlyArray<Action.Any | Event.Any>,
  options: Options = {},
): AnyHttp {
  const { actions, events } = listed(contracts);
  const bound = bindingOf("ActionHttp binding", actions, events, options);
  const mount = mountSegments(options.prefix);
  const security = bound.authentication?.["~middleware"];

  const secured = (endpoint: Route, { caller }: Called) =>
    security === undefined || caller === Anyone ? endpoint : endpoint.middleware(security);

  const endpoints = [
    ...actions.map((action) =>
      secured(
        endpointOf(
          action,
          absolutePath([...mount, action.name]),
          bindingErrors(action, bound),
        ).annotate(OpenApi.Description, action.description),
        action,
      ),
    ),
    ...events.map((event) =>
      secured(
        eventEndpointOf(
          event,
          absolutePath([...mount, "events", event.name]),
          eventErrors(event, bound),
        ),
        event,
      ),
    ),
  ];

  const api = apiOf(groupName(mount), endpoints);

  return { actions, events, ...bound, prefix: absolutePath(mount), api };
}

// Why: `HttpApiBuilder.group` lays the context it is built in over each request's, so a startup
// value would win over a request's own under one tag. Built in an empty context it lays nothing.
// That relies on `group` reading nothing else there: a service it starts to read fails the build,
// but a reference silently takes its default.
const buildInEmptyContext = <A, E>(group: Layer.Layer<A, E>): Layer.Layer<A, E> =>
  Layer.fromBuild((memoMap, scope) =>
    Effect.setContext(Layer.buildWithMemoMap(group, memoMap, scope), Context.empty()),
  );

// Why: Puts the startup context `buildInEmptyContext` withholds beneath each request's, not over
// it. It wraps the whole route rather than the handler, so `HttpApi`'s own error reporting runs
// once, in the merged context.
const startupBeneathRequest = () =>
  HttpRouter.middleware(
    Effect.map(Effect.context<unknown>(), (built) => {
      const startup = Context.omit(Scope.Scope)(built);

      return (route) =>
        Effect.updateContext(route, (current: Context.Context<never>) =>
          Context.merge(startup, current),
        );
    }),
  ).layer;

// Why: A middleware of its own, just inside authentication, answers a step-up refusal. Effect's
// security middleware sees a route's failure only wrapped in a private type, and a refusal recorded
// in the handler, as MCP records it, would override a layer middleware that recovers from it or
// replaces it.
class StepUp extends HttpApiMiddleware.Service<StepUp>()("effect-actions/ActionHttp/StepUp") {}

class JsonContentType extends HttpApiMiddleware.Service<JsonContentType>()(
  "effect-actions/ActionHttp/JsonContentType",
) {}

// Why: Effect reads a body with no `Content-Type` as JSON, which a page on another site can send
// without a CORS preflight; a wrong type Effect refuses itself.
const jsonContentType = () =>
  Layer.succeed(JsonContentType, (route) =>
    Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
      request.headers["content-type"] === undefined
        ? Effect.succeed(HttpServerResponse.text("Unsupported content-type: none", { status: 415 }))
        : route,
    ),
  );

/**
 * Serve the binding's actions and event types among `implementations` in one layer, or those its
 * `actions` lists, authenticating a protected action's request before decoding it, then running
 * its implementation's `authorize` before each handler. An implementation's actions the binding
 * leaves out have no route here, one holding none of those served is not built, and a non-empty
 * list holding none of the binding's actions is refused when `layer` is called. Several layers
 * may serve one binding, each with its own `actions` and `middleware` covering its routes only.
 * The layer fails as the builders do, needs at startup what they need, and per request what the
 * authorization and handlers of the actions it serves need, until its `middleware` or middleware
 * around it provides them, the identity of a protected action excepted, which its authentication
 * provides; what is provided per request wins over what the layer was built with. A declared
 * error answers with its JSON at the status `Action.Options.error` gives it, input that does not
 * decode a 400 `InvalidInput`, and a refusal as `Action.Unauthenticated` and `Action.Forbidden`
 * say.
 *
 * **Gotchas**
 *
 * - A success is its JSON as the body; an action without `success` answers an empty 200, no body and no content type, so a hand-written client must not parse it, or an empty 204 where it declares `progress`. One without `input` still takes the body `{}` typed as JSON: no body is a 400.
 * - An action declaring `progress` answers a request whose `Accept` names `text/event-stream`, whatever else it names, with an SSE stream, listed in OpenAPI: a `progress` event for each value, its data the value's JSON, then one `final` event holding the answer's JSON, `null` for none; without that `Accept` it answers as any action, its progress dropped.
 * - An action answering a stream, `Action.Stream`, answers an SSE stream alone, whatever `Accept` says: an `element` event for each element, its data the element's JSON, and a `progress` event for each value where it declares `progress`; a stream of none answers a 200 with no event. A failure before the first event answers its status; one after ends the stream as Effect's stream failure event, a defect as `Internal server error`.
 * - The stream starts with the call's first event, so a failure before it, a refusal included, answers as it would without the stream; a declared failure after it ends the stream with Effect's `effect/http-api/stream/failure` event, reported as `Info` as without the stream, and a defect or an answer that does not encode with one saying `Internal server error`, its cause logged and reported.
 * - A body that is not JSON is a 400 `InvalidInput`; a request with no `Content-Type` a 415 `Unsupported content-type: none`, one with another type Effect's own 415; each after authentication on a protected route.
 * - A defect, an undeclared failure, or a success or an error that does not encode answers an empty 500: the cause goes to the log and to the call's `ErrorReporter`s, never to the body.
 * - A path no layer serves, or a method other than `POST` on a route, is a 404.
 * - The 415 keeps from every handler what another site's page can send without a CORS preflight, such as a form post carrying the user's cookie; the server's CORS policy decides the rest.
 * - Router middleware providing a request service `X` is declared `HttpRouter.middleware<{ provides: X }>()`: without the type argument it runs and the layer still owes `X`.
 * - `HttpRouter.provideRequest(layer)` builds its layer once, at startup, so it never provides an identity or a tenant.
 * - A request body is read whole, however large, unless the host provides `HttpServerRequest.MaxBodySize` to `HttpRouter.serve`, limiting every route that reads its body whole, MCP endpoints included; a body a route reads as a stream is not limited. On Node a request over it is an empty 413 from Effect 4.0.6, and before it gets no response, its connection closed; `HttpRouter.toWebHandler` ignores it, so limit bodies in the platform serving the handler.
 * - An `ErrorReporter` the server runs with is given, as `Info`, a handler's declared failure and an input that does not decode, never a refusal or a refused credential: give an error class `override readonly [ErrorReporter.ignore] = true` to keep it out, and drop `Info` for a built-in error, which takes no mark.
 * - An event's route takes `{ input, cursor }`, a `cursor` omitted or `null` reading from now, and answers a page, `{ events, cursor, truncated, hasMore, nextPollMs }`, or, to a request accepting `text/event-stream`, an SSE stream of `Checked`, `Occurrence`, `Gap` and `Failed` data, a `Checked` every 30 seconds; the stream carries no `id:`, so `Last-Event-ID` resumes nothing: resume from a cursor in the body.
 * - A subscription is refused as an action's call is, before its stream starts, with the route's 401 or 403; a refusal later ends the stream with Effect's `effect/http-api/stream/failure` event.
 * - A source's failure no refusal explains is logged and reported once, sent as a bare `Failed`, and read again from where it reached after 5 seconds, before the stream's first `Checked` too; a poll's is a 500, which `client`'s `watch` reconnects after.
 * - A stream is read only as fast as its client reads it: a slow reader of a log source falls behind its log, and receives a `Gap`.
 * - A protected event with a `subscription` hook needs `principal` on its descriptor to key poll subscribers: without it the layer fails to build with a message naming the event.
 * - On a host with no lasting process, such as `HttpRouter.toWebHandler` on a serverless platform, serve check sources alone, without a `subscription` hook: nothing refuses the others, and under `Event.layerMemory` each instance keeps its own log of a log source, whose cursors another reads as a `Gap`, and its own leases, lost as it ends.
 */
export function layer<const H extends AnyHttp, const Apps extends Served>(
  binding: H,
  implementations: Apps,
): HttpLayer<H, Apps, []>;
export function layer<
  const H extends AnyHttp,
  const Apps extends Served,
  const O extends LayerOptions<Middleware, H["actions"][number] | H["events"][number]>,
>(
  binding: H,
  implementations: Apps,
  options: O &
    ServerOnly<MiddlewareOf<O, Middleware>, H["error"]> &
    NoInfer<Known<O, LayerOptions<Middleware>>>,
): HttpLayer<
  H,
  Apps,
  MiddlewareOf<O, Middleware>,
  Selected<O, H["actions"][number]>,
  SelectedEvents<O, H["events"][number]>
>;
export function layer(
  binding: AnyHttp,
  served: Served,
  options: LayerOptions<Middleware> = {},
): Layer.Layer<never, unknown, unknown> {
  const selected = servingOf("HTTP binding", binding, served, options);
  const { apps, actions, events, eventTypes, authentication } = selected;

  const mount = mountSegments(binding.prefix);
  const name = groupName(mount);

  const routed = (endpoint: Route, { caller }: Called) => {
    const within = withinLayerMiddleware(
      endpoint.middleware(JsonContentType).middleware(SchemaErrors),
      options.middleware,
    );

    return caller === Anyone || authentication === undefined
      ? within
      : within.middleware(StepUp).middleware(authentication["~middleware"]);
  };

  // Why: Without the verifier's errors, which `make` declares: the security middleware answers
  // them itself, so a served route never fails with one.
  const api = apiOf(name, [
    ...actions.map((action) =>
      routed(
        endpointOf(
          action,
          absolutePath([...mount, action.name]),
          projectedErrors(action, binding.error),
        ),
        action,
      ),
    ),
    ...eventTypes.map((event) =>
      routed(
        eventEndpointOf(
          event,
          absolutePath([...mount, "events", event.name]),
          eventErrors(event, { error: binding.error }),
          servedSent,
        ),
        event,
      ),
    ),
  ]).annotate(HttpApi.PayloadParseOptions, inputParseOptions);

  const handlers = Layer.unwrap(
    Effect.gen(function* () {
      const bound = yield* acquire(apps);
      const feeds = yield* acquireFeeds(events);
      const refusal = unkeyedHook("ActionHttp", feeds, authentication?.principal !== undefined);

      if (refusal !== undefined) return yield* Effect.die(new Error(refusal));

      const security =
        authentication === undefined
          ? Layer.empty
          : yield* Effect.map(providerOf(authentication), (provider) =>
              Layer.mergeAll(
                Layer.succeed(authentication["~middleware"], provider.middleware),
                Layer.succeed(StepUp, provider.stepUp),
              ),
            );

      const hostProvidedMiddleware = yield* Effect.forEach(options.middleware ?? [], (key) =>
        Effect.map(Effect.service(key), (service) => Layer.succeed(key, service)),
      );

      const byName = {
        ...Object.fromEntries(
          bound.map(([action, run]) => {
            const answer = answerOf(action, run);

            return [action.name, (request: Request) => answer(request.payload)] as const;
          }),
        ),
        ...Object.fromEntries(
          feeds.map((feed) => [feed.event.name, answering(feed, authentication)] as const),
        ),
      };

      return HttpApiBuilder.group(api, name, (builder) =>
        builder.handleAll(
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dynamic endpoint registration boundary: the native router selects the endpoint, and so the action, before its handler runs; `layer`'s signature restores every channel.
          byName as never,
        ),
      ).pipe(
        Layer.provide([schemaErrors(), jsonContentType(), security, ...hostProvidedMiddleware]),
        buildInEmptyContext,
      );
    }),
  ).pipe(provideServed(selected));

  return HttpApiBuilder.layer(api).pipe(
    Layer.provide(handlers),
    Layer.provide(startupBeneathRequest()),
  );
}

/**
 * Effect's native `HttpApiClient` for a binding, one method per action taking the
 * action's input directly: `client.greet({ name })`, the argument omitted when `{}` is a valid
 * input. Requires the native `HttpClient`, as `HttpApiClient.make` does; the native client
 * itself stays available: `HttpApiClient.make(Http.api)`. Each call fails with its
 * `MethodError`, an undeclared answer such as a 502 from a proxy or a defect's empty 500 as an
 * `HttpClientError`, and with what `transformClient` adds.
 *
 * **Gotchas**
 *
 * - An input that does not encode fails with `InvalidInput`, and nothing is sent; undeclared input fields, which TypeScript lets through on a wider value, are dropped as it encodes, since the server would refuse them.
 * - It interprets no status and retries nothing: a failed write may have happened, and only a declared error says what the server did.
 * - `watch(event, input, options)` holds the event's SSE stream open, or polls its pages with `mode: "poll"`, as `Action.client`'s; a watch of an event the server does not serve, its route a 404, fails with `Event.SubscriptionError`, reason `NotServed`.
 * - A watch reconnects after the transport fails, a status such as 503, or 60 seconds without an answer or a frame, a second later and doubling to 30 seconds, each reconnect logged as a warning; a declared error, a refusal included, ends it.
 * - A watch's stream ends at an SSE `retry:` field, which `ActionHttp.layer` never sends, as Effect's client decodes it, and the watch connects again: a server or proxy sending one as each stream starts delivers nothing.
 * - A call of an action declaring `progress` reads the route's event stream, as every request accepts it, and its answer from the `final` event; the server sends the values whether or not the call gave `onProgress`, and without one they are dropped.
 * - A call of an action answering a stream returns a `Stream` of its elements, failing as the route's stream fails, with `Sse.SseError` or `Sse.Retry` too; its `onProgress` gets each `progress` event, which the server sends whether or not the call gave one.
 */
export function client<const H extends AnyHttp>(
  binding: H,
  options?: ClientOptions,
): Effect.Effect<Client<H>, never, HttpClient.HttpClient>;
export function client<const H extends AnyHttp, E, R>(
  binding: H,
  options: ClientOptions<E, R>,
): Effect.Effect<Client<H, E, R>, never, HttpClient.HttpClient>;
export function client(
  binding: AnyHttp,
  options?: ClientOptions | ClientOptions<unknown, unknown>,
): Effect.Effect<unknown, never, HttpClient.HttpClient> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased implementation: the native client is invariant in what it fails with and requires, so no one type holds both overloads' options; each overload states the channels its own options give.
  return methods(binding, options as ClientOptions<unknown, unknown>);
}

/**
 * `client` built once over `fetch`, for code that holds a client outside an Effect, such as
 * a browser app: its methods are the same Effects, which require only what `transformClient`
 * requires, so a call without one runs alone, as `Effect.runPromise(api.greet({ name }))`. The
 * options are `client`'s, and `fetch`.
 */
export function fetchClient<const H extends AnyHttp>(
  binding: H,
  options?: FetchClientOptions,
): Client<H>;
export function fetchClient<const H extends AnyHttp, E, R>(
  binding: H,
  options: FetchClientOptions<E, R>,
): Client<H, E, R>;
export function fetchClient(
  binding: AnyHttp,
  { fetch, ...options }: FetchClientOptions | FetchClientOptions<unknown, unknown> = {},
): object {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Erased implementation: as `client`'s, each overload states the channels its own options give. Building runs no request, so it needs only the `HttpClient` provided here; what a transform requires, each call requires.
  return methods(binding, options as ClientOptions<unknown, never>).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(
      FetchHttpClient.Fetch,
      fetch ?? ((input, init) => globalThis.fetch(input, init)),
    ),
    Effect.runSync,
  );
}
