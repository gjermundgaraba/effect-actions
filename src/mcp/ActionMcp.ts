import {
  Cause,
  Context,
  Effect,
  ErrorReporter,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Schema,
  Stdio,
  Stream,
} from "effect";
import type { McpProtocol } from "effect/ai";
import { AiError, McpSchema, McpServer } from "effect/ai";
import { HttpRouter, HttpServerRequest } from "effect/http";
import type { Headers, HttpServerResponse } from "effect/http";

import { promote, providerOf } from "../authentication/provider.js";
import type {
  Any as Authentication,
  ProviderOf,
  Matching,
  RemoteRequest,
  Required as RequiredAuthentication,
  ServerBuildServices,
} from "../authentication/provider.js";
import { recordStepUp } from "../authentication/refusal.js";
import type * as Action from "../contract/Action.js";
import { inputParseOptions } from "../contract/call.js";
import { Anyone, assertAuthentication } from "../contract/caller.js";
import type { Codec } from "../contract/codec.js";
import { projectedErrors } from "../contract/declared.js";
import type * as Event from "../contract/Event.js";
import type {
  EventBuildError,
  EventBuildServices,
  EventOf,
  EventRequestOf,
  EventServedRequest,
  HoldingEvents,
} from "../contract/feed.js";
import { hintsOf } from "../contract/hints.js";
import { acquire, answeringWhole } from "../contract/implementation.js";
import type {
  Protected,
  ActionOf,
  AnyImplementation,
  BuildServices,
  BuildError,
  ErasedValue,
  Holding,
  Member,
  Known,
  SelectedEventsOf,
  SelectedOf,
  Selection,
  Served,
  ServedRequest,
} from "../contract/implementation.js";
import { assertOnce, heldOnce } from "../contract/names.js";
import { provideServed, selectFrom } from "../contract/serving.js";
import { toolSuccessOf } from "../contract/stream.js";
import { withStderrConsole } from "../stdio/console.js";
import {
  eventSchemasOf,
  refuseUnservable,
  serveWebhooks,
  withEvents,
} from "./bridge.js";
import type { Serving } from "./bridge.js";
import { progressNotifier } from "./progress.js";
import {
  defaultPath,
  fieldKey,
  httpProtocol,
  isMisplaced,
  isObjectSchema,
  liftedFrom,
  liftOf,
  protocols,
  routingFormsOf,
  toolJsonSchema,
} from "./protocol.js";
import type { Lift, Lifted } from "./protocol.js";

export { client } from "./client.js";

export { McpCallError } from "./reply.js";

export { request } from "./request.js";

export type { Client, ClientOptions } from "./client.js";

export type { Params, RequestOptions } from "./request.js";

/**
 * An MCP server, over HTTP or stdio: every native `McpServer.layerStdio` option but `protocols`,
 * the server information, `instructions` and `extensions` among them, the actions `A` that are
 * its tools and the event types `A` it serves, and the native features it serves beside them.
 */
export interface Options<
  E = never,
  R = never,
  A extends Action.Any | Event.Any = Action.Any | Event.Any,
> extends Omit<Parameters<typeof McpServer.layerStdio>[0], "protocols"> {
  /**
   * The actions that are tools and the event types it serves, among the implementations':
   * `[GetUser, RenameUser, UserRenamed]`, exactly those. Each keeps its implementation's
   * authorization and builder. Defaults to every action and event type of them.
   *
   * **Gotchas**
   *
   * - A list naming actions alone serves no event type: the events extension is not declared, and `events/*` answer `-32601`, until the event types are listed beside them.
   */
  readonly actions?: readonly A[] | undefined;
  /**
   * Native MCP features served beside the actions' tools, such as `McpServer.resource`,
   * `McpServer.prompt` and `McpServer.toolkit` layers merged into one. They register on this
   * server's registry and run with the services they were built with, and no `authorize` runs for
   * them.
   *
   * **Gotchas**
   *
   * - Merged beside the endpoint instead of passed here, they register on another registry and are never served, without an error.
   * - A service provided to this layer itself is built again for the features alone, so a resource reads another store than the tools write: provide it around the endpoint.
   * - They never receive a request's services, so they cannot read the caller: content that depends on the caller is an action.
   */
  readonly features?: Layer.Layer<never, E, R> | undefined;
}

/**
 * One Streamable HTTP MCP endpoint: `Options`, `authentication`, `requestScoped`, and every native
 * `McpServer.layerHttp` option, `allowedOrigins` among them, except `protocols` and
 * `allowSessionTermination`, which are fixed.
 */
export interface LayerHttpOptions<
  E = never,
  R = never,
  A extends Action.Any | Event.Any = Action.Any | Event.Any,
>
  extends
    Options<E, R, A>,
    Omit<
      Parameters<typeof McpServer.layerHttp>[0],
      "protocols" | "path" | "allowSessionTermination"
    > {
  /** The endpoint's route; defaults to `/mcp`. */
  readonly path?: HttpRouter.PathInput;
  /**
   * The descriptor the protected tools' contracts name, whose provider, built by
   * `Authentication.layer`, the routes provide. On an endpoint of protected tools only, every
   * request authenticates before it is decoded; on a mixed one, anyone may discover the server,
   * list its tools, cancel, and call a public tool in a 2026-07-28 request, and everything else
   * authenticates first.
   *
   * **Gotchas**
   *
   * - A credential a request presents is still verified, on a public tool's call too: an expired or invalid one answers 401, its challenge naming `invalid_token`, on which a client refreshes it or signs in again.
   * - `tools/list` names every tool, protected ones included: serve public tools on an endpoint of their own if signed-out callers must not see the rest.
   * - A client of a 2025 revision opens a session, which on an endpoint serving a protected tool only a signed-in caller does: it signs in for every request there, a public tool's call and `tools/list` included.
   * - Every prompt and resource request needs a credential, listings included: to offer them signed out, serve them on an endpoint without protected tools.
   * - A handler that sends a notification starts the response, so a refusal after it is an `isError: true` tool result, not the 401 or 403 a client re-authorizes on: refuse in `authorize`.
   */
  readonly authentication?: Authentication;
  /**
   * Whether MCP 2026-07-28 clients may subscribe, holding a stream open for list changes and
   * resource updates. Defaults to whether `features` or event implementations are given: an
   * endpoint of actions alone registers its tools once, before any client connects, and serves no
   * resource. Pass `true` where a handler changes the server through `McpServer.McpServer`.
   *
   * **Gotchas**
   *
   * - `false` also serves events by poll alone: Effect's server pushes no notification without subscriptions, so `events/list` lists `["poll"]` and `events/stream` answers `-32026`.
   */
  readonly allowSubscriptions?: boolean | undefined;
  /**
   * `true` runs a server per request, as Effect's `McpServer.layerHttpRequestScoped` does, for a
   * host such as Cloudflare Workers where nothing may outlive a request. It speaks MCP 2026-07-28
   * alone, so a client that opens with `initialize` is refused; it keeps no session and takes only
   * `POST`, a `DELETE` answering 405. It has no subscriptions, so `allowSubscriptions` is ignored,
   * and native `features` send no list-change notification. `McpServer.elicit` reaches no client
   * on it, as Effect's `McpServer.layerHttpRequestScoped` says.
   */
  readonly requestScoped?: boolean | undefined;
}

type ToolRequestContext<R> = Exclude<
  R,
  McpSchema.McpRequestContext | McpServer.McpServer
>;

type HttpToolRequestContext<R> = Exclude<
  ToolRequestContext<R>,
  HttpRouter.Provided
>;

type Features<R> = Exclude<R, McpServer.McpServer>;

type Contracts<Apps extends Served, O> =
  | SelectedOf<O, Apps>
  | SelectedEventsOf<O, Apps>;

type ServerError<Apps extends Served, O> =
  | BuildError<Holding<Member<Apps>, SelectedOf<O, Apps>>, SelectedOf<O, Apps>>
  | EventBuildError<
      HoldingEvents<Member<Apps>, SelectedEventsOf<O, Apps>>,
      SelectedEventsOf<O, Apps>
    >
  | Cause.IllegalArgumentError;

type EventServices<Apps extends Served, O> = EventBuildServices<
  HoldingEvents<Member<Apps>, SelectedEventsOf<O, Apps>>,
  SelectedEventsOf<O, Apps>
>;

const assertToolsServable = (
  lifted: ReadonlyArray<readonly [Action.Any, Lift]>
): void => {
  const actions = lifted.map(([action]) => action);

  const inputs = actions.flatMap(({ input, name }) =>
    isObjectSchema(toolJsonSchema(Schema.toCodecJson(input), true))
      ? []
      : [name]
  );

  if (inputs.length > 0) {
    throw new Error(
      `MCP tool input must be one object with keys, such as a struct: ${inputs.join(", ")} (wrap a union, an array or a scalar in a field, omit input for no arguments, or leave the action out of actions)`
    );
  }

  const misplaced = lifted.flatMap(([action, lift]) =>
    isMisplaced(action, lift) ? [action.name] : []
  );

  if (misplaced.length > 0) {
    throw new Error(
      `MCP media must be the success or an array of it, or a top-level field of a struct success, one, optional or a required array: ${misplaced.join(", ")} (make the image such a field, or give an optional array as a required one, empty when absent; an image in input or an error is not served over MCP, so leave that action out of actions)`
    );
  }
};

const nativeInternalErrorText =
  "Tool execution failed due to an internal server error.";

const textErrorResult = (text: string) =>
  new McpSchema.CallToolResult({
    isError: true,
    content: [{ type: "text", text }],
  });

const nativeJsonTextOf = (
  encoded: ErasedValue
): McpSchema.CallToolResult["content"] =>
  encoded === undefined
    ? []
    : [{ type: "text", text: JSON.stringify(encoded) }];

const contentBlockOf = ({
  kind,
  field,
  value,
}: Lifted): McpSchema.ContentBlock => ({
  type: kind,
  data: value.data,
  mimeType: value.mimeType,
  ...(field === undefined ? {} : { _meta: { [fieldKey]: field } }),
});

const toolOf = (
  action: Action.Any,
  outputSchema: McpSchema.Tool["outputSchema"]
) =>
  Effect.map(
    Schema.decodeUnknownEffect(McpSchema.ToolJson)(
      toolJsonSchema(Schema.toCodecJson(action.input), true)
    ),
    (inputSchema) =>
      new McpSchema.Tool({
        name: action.name,
        description: action.description,
        inputSchema,
        outputSchema,
        annotations: {
          ...(action.mcp.title === undefined
            ? {}
            : { title: action.mcp.title }),
          ...hintsOf(action),
        },
        _meta:
          action.mcp._meta === undefined ? undefined : { ...action.mcp._meta },
      })
  );

const internalError = (cause: Cause.Cause<ErasedValue>) =>
  Effect.logError(cause).pipe(
    Effect.andThen(ErrorReporter.report(cause)),
    Effect.as(textErrorResult(nativeInternalErrorText))
  );

const internalErrorOnDefect = (cause: Cause.Cause<McpSchema.InvalidParams>) =>
  Cause.hasDies(cause) ? internalError(cause) : Effect.failCause(cause);

const encoder = (schema: Codec) => {
  const encode = Schema.encodeUnknownEffect(Schema.toCodecJson(schema));

  return (value: ErasedValue) => Effect.orDie(encode(value));
};

const registerTools = Effect.fnUntraced(function* (
  apps: readonly AnyImplementation[],
  authentication: Authentication | undefined
) {
  const registry = yield* McpServer.McpServer;
  const bound = yield* acquire(apps, authentication);
  const built = yield* Effect.context<unknown>();

  for (const [action, handler] of bound) {
    const toolSuccess = toolSuccessOf(action.success);
    const run = answeringWhole(action, handler);
    const lift = liftOf(toolSuccess);
    const media = lift.fields.length === 0 ? undefined : lift;

    const structuredSuccess = media === undefined ? toolSuccess : media.rest;

    const structured =
      structuredSuccess === undefined
        ? undefined
        : Schema.toCodecJson(structuredSuccess);

    const outputSchema =
      structured === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(McpSchema.ToolOutputJson)(
            toolJsonSchema(structured, false)
          ).pipe(Effect.orDie);

    const tool = yield* toolOf(action, outputSchema).pipe(Effect.orDie);

    const decode = Schema.decodeUnknownEffect(
      Schema.toCodecJson(action.input),
      inputParseOptions
    );

    const encodeSuccess = encoder(toolSuccess);
    const encodeFailure = encoder(Schema.Union(projectedErrors(action)));

    const reported = (input: ErasedValue) =>
      action.progress === undefined
        ? run(input)
        : Effect.flatMap(
            progressNotifier(registry.notifications, action.progress),
            (sink) => run(input, sink)
          );

    const call =
      authentication === undefined || action.caller === Anyone
        ? reported
        : (input: ErasedValue) =>
            recordStepUp(promote(authentication, reported(input)));

    const liftedFieldNames = new Set(media?.fields.map(({ name }) => name));

    const resultOf = (encoded: ErasedValue, success: ErasedValue) => {
      if (media === undefined) {
        return new McpSchema.CallToolResult({
          isError: false,
          structuredContent: encoded,
          content: nativeJsonTextOf(encoded),
        });
      }

      const blocks = liftedFrom(media, success).map(contentBlockOf);

      if (structured === undefined) {
        return new McpSchema.CallToolResult({
          isError: false,
          content: blocks,
        });
      }

      const encodedRestOfStruct = Predicate.isObject(encoded)
        ? Object.fromEntries(
            Object.entries(encoded).filter(
              ([key]) => !liftedFieldNames.has(key)
            )
          )
        : encoded;

      return new McpSchema.CallToolResult({
        isError: false,
        structuredContent: encodedRestOfStruct,
        content: [...nativeJsonTextOf(encodedRestOfStruct), ...blocks],
      });
    };

    yield* registry.addTool({
      tool,
      annotations: Context.empty(),
      handle: (payload: ErasedValue) =>
        Effect.annotateCurrentSpan({ tool: action.name }).pipe(
          Effect.andThen(() => decode(payload ?? {})),
          Effect.mapError(
            ({ message }) =>
              new McpSchema.InvalidParams({
                message: new AiError.ToolParameterValidationError({
                  toolName: action.name,
                  description: message,
                }).message,
              })
          ),
          Effect.flatMap((input) =>
            call(input).pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  Effect.map(
                    encodeFailure(error),
                    (encoded) =>
                      new McpSchema.CallToolResult({
                        isError: true,
                        content: nativeJsonTextOf(encoded),
                      })
                  ),
                onSuccess: (success) =>
                  Effect.map(encodeSuccess(success), (encoded) =>
                    resultOf(encoded, success)
                  ),
              })
            )
          ),
          Effect.catchCause(internalErrorOnDefect),
          Effect.updateContext(
            (request: Context.Context<McpSchema.McpRequestContext>) =>
              Context.merge(built, request)
          )
        ),
    });
  }
});

const assertEventsServable = (events: readonly Event.Any[]): void => {
  assertOnce("MCP event", events);

  const reserved = events.find(({ name }) => name.startsWith("mcp."));

  if (reserved !== undefined) {
    throw new Error(
      `MCP event name starts with "mcp.", which MCP keeps for its own events: ${reserved.name} (rename it, or serve it on another surface)`
    );
  }

  for (const event of events) {
    eventSchemasOf(event);
  }
};

const servingEvents = <P extends readonly McpProtocol.AnyProtocolAdapter[]>(
  [stateless, ...rest]: readonly [typeof httpProtocol, ...P],
  serving: Serving
): readonly [
  McpProtocol.ProtocolAdapter<
    "2026-07-28",
    McpProtocol.StatelessRuntimeDescriptor
  >,
  ...P,
] =>
  serving.events.length === 0
    ? [stateless, ...rest]
    : [withEvents(stateless, serving), ...rest];

const server = <Out, R>(
  apps: readonly AnyImplementation[],
  serving: Serving,
  transport: Layer.Layer<Out, Cause.IllegalArgumentError, R>,
  features: Layer.Layer<never, unknown, unknown> = Layer.empty
) => {
  const { events, authentication } = serving;

  assertOnce(
    "MCP tool",
    apps.flatMap((app) => app.actions),
    heldOnce
  );

  const lifted = apps.flatMap((app) =>
    app.actions.map(
      (action) => [action, liftOf(toolSuccessOf(action.success))] as const
    )
  );

  assertToolsServable(lifted);

  const names = new Set(lifted.map(([{ name }]) => name));

  const register = Effect.gen(function* () {
    const registry = yield* McpServer.McpServer;

    const namesClaimedByFeatures = registry.tools.flatMap(({ tool }) =>
      names.has(tool.name) ? [tool.name] : []
    );

    if (namesClaimedByFeatures.length > 0) {
      return yield* Effect.die(
        new Error(
          `Duplicate MCP tool: ${namesClaimedByFeatures.join(", ")}, claimed by an action and a native feature (rename the native tool, or leave the action out of actions)`
        )
      );
    }

    yield* refuseUnservable(serving);
    yield* serveWebhooks(serving);
    yield* registerTools(apps, authentication);
  });

  return Layer.effectDiscard(register).pipe(
    Layer.provide(features),
    Layer.provide(transport),
    Layer.fresh,
    provideServed({ apps, events })
  );
};

const anonymousMethods = new Set([
  "server/discover",
  "tools/list",
  "events/list",
  "notifications/cancelled",
]);

const namedMethods = new Map<string, "tool" | "event">([
  ["tools/call", "tool"],
  ["events/poll", "event"],
  ["events/stream", "event"],
]);

const openOf = (
  contracts: ReadonlyArray<Pick<Action.Any, "name" | "caller">>
) =>
  new Set(
    contracts
      .filter(({ caller }) => caller === Anyone)
      .flatMap(({ name }) => routingFormsOf(name))
  );

const requiresAuthentication = (
  actions: readonly Action.Any[],
  events: readonly Event.Any[]
) => {
  const open = { tool: openOf(actions), event: openOf(events) };

  return (headers: Headers.Headers): boolean => {
    if (open.tool.size === 0 && open.event.size === 0) {
      return true;
    }

    if (headers["mcp-protocol-version"] !== httpProtocol.protocolVersion) {
      return true;
    }

    const method = headers["mcp-method"];

    if (method === undefined) {
      return true;
    }

    if (anonymousMethods.has(method)) {
      return false;
    }

    const named = namedMethods.get(method);

    if (named === undefined) {
      return true;
    }

    const name = headers["mcp-name"];

    return name === undefined || !open[named].has(name);
  };
};

const namesItsMethod = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.match(request.json, {
    onFailure: () => true,
    onSuccess: (body) =>
      !Predicate.hasProperty(body, "method") ||
      body.method === request.headers["mcp-method"],
  });

const readsItsBody = <E, R>(
  route: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    request.method === "POST" ? Effect.andThen(request.text, route) : route
  );

type Inferring<D, A extends Pick<Action.Any, "caller">> = [D] extends [
  undefined,
]
  ? [Protected<A>] extends [never]
    ? { readonly authentication?: undefined }
    : unknown
  : { readonly authentication?: D };

/**
 * Serve MCP tools over one Streamable HTTP endpoint, speaking MCP 2026-07-28, 2025-11-25 or
 * 2025-06-18, as the client negotiates. A 2026-07-28 request stands alone; a client of a 2025
 * revision opens a session with `initialize`, which holds what it sent there and no identity,
 * and lasts until that client ends it with a DELETE, answered 204, or the process stops. Protected
 * tools need `authentication`; for a serverless host, see `requestScoped`. In a tool call, what
 * middleware provides per request wins over what the endpoint was built with. The event
 * types among `implementations`, or those `actions` lists, are served as SEP-3415 events,
 * `events/list`, `events/poll` and `events/stream`, and, where `Webhook.layer` is provided, `events/subscribe`
 * and `events/unsubscribe`: experimental, as that extension is a draft, pinned to its PR head
 * 2ec39b9c49c583411b73cb460dea5f52b5c541a6.
 * Guide: `docs/ActionMcp.md` in this package; in an application: `examples/mcp-tools/`, and
 * `examples/build-events/` for events.
 *
 * **Gotchas**
 *
 * - A success is `isError: false` with `structuredContent` its JSON and the same JSON as one text block, both `null` for an action without `success`; an `Action.Image` field is left out of `structuredContent` and its text, its block following them, and a success of images alone has no `structuredContent`.
 * - A declared error is an `isError: true` tool result in a 200 holding its JSON as one text block, with no `structuredContent`; a refusal is answered as `Action.Unauthenticated` and `Action.Forbidden` say.
 * - An action answering a stream, `Action.Stream`, answers its elements collected into one array once the stream ends, a success of that array.
 * - An action declaring `progress` sends each value as `notifications/progress` on the `progressToken` its call's `_meta` carries, before the result: `progress` counts from 1, `message` is the value's JSON and `_meta["effect-actions/progress"]` the value; a call without a token gets none.
 * - Arguments that do not decode never reach the handler: an `isError: true` result in a 200, text `Invalid parameters for tool '<name>': …`, or for a 2025-06-18 client a JSON-RPC error.
 * - A defect, an undeclared failure, or a success or an error that does not encode is `isError: true`, text `Tool execution failed due to an internal server error.`: the cause goes to the log and to the call's `ErrorReporter`s, never to the client.
 * - An unknown tool is a JSON-RPC error `-32602` in a 200; a body that is not JSON a JSON-RPC error `-32700` in a 200; a `Content-Type` missing or not JSON an empty 415; another HTTP method an empty 405 with `Allow: POST, DELETE`, `Allow: POST` where `requestScoped`, or the 401 of an endpoint with authentication when signed out.
 * - A 2025-11-25 or 2025-06-18 client gets `structuredContent` only for a success that is an object: any other success arrives as its text block alone, a string unquoted.
 * - A client asking for an earlier revision, such as 2025-03-26, is offered 2025-11-25, so a client speaking only that earlier one cannot connect.
 * - A request body is read whole, however large, and a 2025 session holds what its `initialize` sent until it ends, so an oversized `initialize` costs memory for that long: limit bodies as `ActionHttp.layer` says.
 * - An event type named starting with `mcp.`, a prefix MCP keeps for its own events, is refused as the endpoint is made, with `MCP event name starts with "mcp."`.
 * - Events are 2026-07-28's alone: a 2025 session gets `-32601` for `events/*`, and its `initialize` advertises no events extension.
 * - With `requestScoped`, `events/stream` answers `-32026`, no server outliving a request to push, so events are served by poll, and by webhook where `Webhook.layer` is provided; their sources, logs, `subscription` hooks' leases and webhook subscriptions are built once with the endpoint, as without it.
 * - On a host with no lasting process, such as a serverless platform, serve check sources alone, without a `subscription` hook: nothing refuses the others, and under `Event.layerMemory` each instance keeps its own log of a log source, whose cursors another reads as a gap, and its own leases, lost as it ends.
 * - A protected event with a `subscription` hook needs `principal` on `authentication`, or the endpoint is refused at startup: a poll's hook is held per principal between requests.
 * - A push stream holds its request open while it is read, a heartbeat every 30 seconds: a host's request timeout ends it, and `client`'s `watch` reconnects from its cursor.
 * - A poll's `maxEvents` caps a log source's page, at most 100, and is not honored for a check source, whose page is answered whole since only its last cursor resumes; `maxAgeMs` is accepted and not honored, a log source keeping what its `log.maxAge` and `log.maxEvents` say.
 * - A push stream's failure that no refusal explains, such as an upstream's outage, is `notifications/events/error`, its cause logged and reported, and the stream resumes from where it reached after 5 seconds; a refusal ends it with `notifications/events/terminated`. One before `active`, or a poll's, is a JSON-RPC `-32603`, which `client`'s `watch` reconnects after, as after a 5xx.
 */
export function layerHttp<
  const Apps extends Served,
  const O extends Selection<ActionOf<Member<Apps>> | EventOf<Member<Apps>>> =
    {},
  E = never,
  R = never,
  const D extends Authentication | undefined = undefined,
>(
  implementations: Apps,
  options: LayerHttpOptions<
    E,
    R,
    ActionOf<Member<Apps>> | EventOf<Member<Apps>>
  > &
    O &
    NoInfer<Known<O, LayerHttpOptions<E, R>>> &
    NoInfer<RequiredAuthentication<Contracts<Apps, O>>> &
    Matching<NoInfer<Contracts<Apps, O>>, NoInfer<D>> &
    Inferring<D, NoInfer<Contracts<Apps, O>>>
): Layer.Layer<
  never,
  ServerError<Apps, O> | E,
  | ServerBuildServices<
      Holding<Member<Apps>, SelectedOf<O, Apps>>,
      SelectedOf<O, Apps>
    >
  | EventServices<Apps, O>
  | HttpRouter.HttpRouter
  | HttpRouter.Request.From<
      "Requires",
      HttpToolRequestContext<
        | RemoteRequest<Member<Apps>, SelectedOf<O, Apps>>
        | EventServedRequest<Member<Apps>, SelectedEventsOf<O, Apps>>
      >
    >
  | ProviderOf<D>
  | Features<R>
>;
export function layerHttp(
  apps: Served,
  {
    actions,
    features,
    path = defaultPath,
    authentication,
    requestScoped,
    allowSubscriptions,
    ...options
  }: LayerHttpOptions<unknown, unknown>
) {
  const { apps: selected, events } = selectFrom(apps, actions);
  const served = selected.flatMap((app) => app.actions);
  const listed = events.flatMap((app) => app.events);
  assertAuthentication(served, authentication);
  assertAuthentication(listed, authentication, "event");
  assertEventsServable(listed);

  const serving = { events, authentication };

  const transport = server(
    selected,
    serving,
    requestScoped === true
      ? McpServer.layerHttpRequestScoped({
          ...options,
          path,
          protocols: servingEvents([httpProtocol], serving),
        })
      : McpServer.layerHttp({
          ...options,
          path,
          protocols: servingEvents(protocols, serving),
          allowSessionTermination: true,
          allowSubscriptions:
            allowSubscriptions ?? (features !== undefined || events.length > 0),
        }),
    features
  );

  if (authentication === undefined) {
    return transport.pipe(
      Layer.provide(HttpRouter.middleware(readsItsBody).layer)
    );
  }

  const required = requiresAuthentication(served, listed);

  const middleware = HttpRouter.middleware(
    Effect.map(
      providerOf(authentication),
      (runtime) => (route) =>
        Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
          request.method !== "POST" || required(request.headers)
            ? runtime.http(readsItsBody(route), false)
            : Effect.flatMap(namesItsMethod(request), (named) =>
                runtime.http(readsItsBody(route), named)
              )
        )
    )
  );

  return transport.pipe(Layer.provide(middleware.layer));
}

const isJsonLine = (line: string): boolean =>
  Option.isSome(Schema.decodeOption(Schema.fromJsonString(Schema.Json))(line));

const jsonLinesOnly = Layer.effect(
  Stdio.Stdio,
  Effect.map(Stdio.Stdio, (stdio) =>
    Stdio.make({
      ...stdio,
      stdin: stdio.stdin.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.filter(isJsonLine),
        Stream.map((line) => `${line}\n`),
        Stream.encodeText
      ),
    })
  )
);

/**
 * Serve MCP tools through newline-delimited JSON-RPC on standard I/O, speaking MCP
 * 2026-07-28, 2025-11-25 or 2025-06-18, as the host negotiates: the whole
 * program of an MCP subprocess, which succeeds once the host closes its side and every call
 * in flight has been answered. A signal interrupts it. Its own Effect logs and `Console` output
 * go to stderr, since stdout carries the protocol. The host supplies the `Stdio` service, and
 * provides the identity around `runStdio`; arguments are tool input only and never establish
 * request identity or authority, and each implementation's `authorize` runs for its protected
 * actions and events. Its tool results, its events, and how it answers each revision and an
 * earlier one asked for, are `layerHttp`'s.
 *
 * **Gotchas**
 *
 * - A line that is not JSON goes unanswered, with no `-32700` as over HTTP, and the lines after it are still answered.
 * - The layers provided around it log to stdout, among the protocol's lines: apply `ActionCli.logToStderr` to the program, last, as its JSDoc says.
 */
export function runStdio<
  const Apps extends Served,
  const O extends Selection<ActionOf<Member<Apps>> | EventOf<Member<Apps>>> =
    {},
  E = never,
  R = never,
>(
  implementations: Apps,
  options: Options<E, R, ActionOf<Member<Apps>> | EventOf<Member<Apps>>> &
    O &
    NoInfer<Known<O, Options<E, R>>>
): Effect.Effect<
  void,
  ServerError<Apps, O> | E,
  | BuildServices<
      Holding<Member<Apps>, SelectedOf<O, Apps>>,
      SelectedOf<O, Apps>
    >
  | EventServices<Apps, O>
  | Stdio.Stdio
  | ToolRequestContext<
      | ServedRequest<Member<Apps>, SelectedOf<O, Apps>>
      | EventRequestOf<Member<Apps>, SelectedEventsOf<O, Apps>>
    >
  | Features<R>
>;
export function runStdio(
  apps: Served,
  { actions, features, ...options }: Options<unknown, unknown>
) {
  const { apps: selected, events } = selectFrom(apps, actions);
  assertEventsServable(events.flatMap((app) => app.events));

  const serving = { events, authentication: undefined };

  const transport = server(
    selected,
    serving,
    McpServer.layerStdio({
      ...options,
      protocols: servingEvents(protocols, serving),
    }).pipe(Layer.provide(jsonLinesOnly)),
    features
  );

  return Layer.launch(transport).pipe(
    withStderrConsole,
    Effect.forkChild,
    Effect.flatMap(Fiber.await),
    Effect.flatMap((exit) =>
      Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
        ? Effect.failCause(exit.cause)
        : Effect.void
    )
  );
}
