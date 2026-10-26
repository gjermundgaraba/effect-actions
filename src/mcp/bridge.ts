import { Cause, Context, Duration, Effect, Exit, Match, Option, Predicate, Schema } from "effect";
import { type McpProtocol, McpSchema } from "effect/ai";
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { Rpc, RpcGroup, RpcMessage } from "effect/rpc";
import { type Any as Authentication, promote } from "../authentication/provider.js";
import { recordStepUp } from "../authentication/refusal.js";
import { inputParseOptions } from "../contract/call.js";
import { Anyone, principalOf } from "../contract/caller.js";
import type * as Event from "../contract/Event.js";
import {
  acquireFeeds,
  type AnyEventImplementation,
  type Feed,
  unkeyedHook,
} from "../contract/feed.js";
import { encodeUntaggedOf } from "../contract/occurrence.js";
import { type Pushed, pushed, refusalIn } from "../contract/push.js";
import { reported } from "../contract/reported.js";
import type { Refusal } from "../contract/errors.js";
import {
  Active,
  codes,
  EventsError,
  type EventDescriptor,
  extension,
  Failed as FailedNotification,
  Heartbeat,
  Notifications,
  Occurred,
  type PollEvents,
  Requests,
  subscriptionIdKey,
  Terminated,
  terminationError,
  type WireOccurrence,
} from "./events.js";
import { isObjectSchema, routingFormsOf, toolJsonSchema } from "./protocol.js";

type Adapter = McpProtocol.ProtocolAdapter<"2026-07-28", McpProtocol.StatelessRuntimeDescriptor>;

type Installing = Parameters<Adapter["installHandlers"]>;

type Send = (
  protocolVersion: string,
  clientId: number,
  notification: McpProtocol.ProjectedNotification,
) => Effect.Effect<void>;

/**
 * What Effect's runtime hands an adapter's `installHandlers`, as far as the bridge reads it: the
 * installation context, whose `sendNotification` exists where the transport can push, and the
 * installer.
 */
interface Target {
  readonly context: {
    readonly sendNotification?: Send | undefined;
    readonly serverInfo: Schema.Struct.Type<typeof McpSchema.Implementation.fields> & {
      readonly extensions?: McpSchema.ServerCapabilities["extensions"] | undefined;
    };
  };
  readonly install: (
    protocol: { readonly protocolVersion: string },
    rpcs: typeof Requests,
    handlers: RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof Requests>>,
  ) => Effect.Effect<void, never, unknown>;
}

// Why: Effect 4.0.5 keeps an adapter's groups typed as maps and its `handlerRpcs`, which the HTTP
// runtime admits stateless methods by, off its public interface. Reaching them is pinned to the
// 4.0.x line: tests/mcp/bridge.test.ts fails loudly if the groups move, and `Target`, the
// installation target matched against `any`, is guarded only by tests/mcp/events.test.ts, which
// time out if it moves, since Effect runs the installation in a forked fiber.
const isGroup = (u: unknown): u is RpcGroup.RpcGroup<Rpc.AnyWithProps> =>
  Predicate.isObjectKeyword(u) &&
  "merge" in u &&
  Predicate.isFunction(u.merge) &&
  "requests" in u &&
  u.requests instanceof Map;

const groupOf = (adapter: Adapter, key: string): RpcGroup.RpcGroup<Rpc.AnyWithProps> => {
  const group: unknown = Predicate.hasProperty(adapter, key) ? adapter[key] : undefined;

  if (!isGroup(group)) {
    throw new Error(
      `Effect's MCP ${adapter.protocolVersion} adapter holds no ${key} group: effect-actions supports MCP events on effect 4.0.x (install the effect version its peer range names)`,
    );
  }

  return group;
};

/** How the bridge serves events: the implementations, and what the endpoint authenticates with. */
export interface Serving {
  readonly events: ReadonlyArray<AnyEventImplementation>;
  readonly authentication: Authentication | undefined;
}

/**
 * The JSON Schemas `events/list` lists for `event`, refusing an input or a payload that is no
 * object.
 */
export const eventSchemasOf = (
  event: Event.Any,
): Pick<EventDescriptor, "inputSchema" | "payloadSchema"> => {
  const inputSchema = toolJsonSchema(Schema.toCodecJson(event.input), true);

  if (!isObjectSchema(inputSchema)) {
    throw new Error(
      `MCP event input must be one object with keys, such as a struct: ${event.name} (wrap a union, an array or a scalar in a field, or omit input for no arguments)`,
    );
  }

  const payloadSchema = toolJsonSchema(Schema.toCodecJson(event.payload), false);

  if (!isObjectSchema(payloadSchema)) {
    throw new Error(
      `MCP event payload must be one object, such as a struct: ${event.name} (wrap an array or a scalar in a field)`,
    );
  }

  return { inputSchema, payloadSchema };
};

const encodeServerInfo = Schema.encodeEffect(McpSchema.Implementation);

type Notified = RpcGroup.Rpcs<typeof Notifications>;

const refusalError = (refusal: Refusal) => new EventsError(terminationError(refusal));

const internalError = new EventsError({ code: codes.internal, message: "Internal error" });

// Why: A failure no refusal explains is the server's: the cause goes to the log and to the
// request's `ErrorReporter`s, as a tool call's does, and the subscriber reads a bare internal error.
const wireErrorOf = (cause: Cause.Cause<unknown>): Effect.Effect<EventsError> => {
  const refusal = refusalIn(cause);

  return refusal === undefined
    ? Effect.as(reported(cause), internalError)
    : Effect.succeed(refusalError(refusal));
};

const headerMismatch = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.andThen(
    Effect.sync(() =>
      HttpEffect.appendPreResponseHandlerUnsafe(request, (_request, response) =>
        Effect.succeed(HttpServerResponse.setStatus(response, 400)),
      ),
    ),
    Effect.fail(
      new EventsError({
        code: codes.headerMismatch,
        message: "Mcp-Name header does not match request parameters",
      }),
    ),
  );

// Why: Effect's runtime checks `Mcp-Name` against the body for the core methods alone, and a mixed
// endpoint admits a public event's request signed out by that header, so a body naming another
// event is refused here, before it is read, as SEP-3415 requires.
const routedTo = (name: string) =>
  Effect.flatMap(Effect.serviceOption(HttpServerRequest.HttpServerRequest), (request) =>
    Option.isNone(request) || routingFormsOf(name).includes(request.value.headers["mcp-name"] ?? "")
      ? Effect.void
      : headerMismatch(request.value),
  );

type Arguments = (typeof PollEvents.payloadSchema.Type)["arguments"];

interface Served {
  readonly feed: Feed;
  readonly decode: (args: Arguments) => Effect.Effect<Event.Any["input"]["Type"], EventsError>;
  readonly wire: (occurrence: Event.Occurrence<Event.Any>) => Effect.Effect<WireOccurrence>;
  readonly listing: EventDescriptor;
}

const servedOf = (feed: Feed, delivery: EventDescriptor["delivery"]): Served => {
  const { event } = feed;
  const decode = Schema.decodeUnknownEffect(Schema.toCodecJson(event.input), inputParseOptions);

  return {
    feed,
    decode: (args) =>
      Effect.mapError(
        decode(args ?? {}),
        ({ message }) =>
          new EventsError({
            code: codes.invalidParams,
            message: `Invalid arguments for event '${event.name}': ${message}`,
          }),
      ),
    wire: encodeUntaggedOf(event),
    listing: {
      name: event.name,
      description: event.description,
      delivery,
      ...eventSchemasOf(event),
    },
  };
};

/**
 * Dies with the reason the endpoint of `serving` cannot serve one of its events, run where the
 * endpoint's layer is built: a protected one with a `subscription` hook, under an authentication
 * without a principal to key its polls by.
 */
export const refuseUnservable = ({
  events,
  authentication,
}: Serving): Effect.Effect<void, never, unknown> =>
  // Why: Effect forks the server that installs the handlers, so a defect there ends only that
  // fiber and every request waits; the refusal runs beside the tools' registration, failing the
  // layer.
  authentication === undefined
    ? Effect.void
    : Effect.flatMap(acquireFeeds(events), (feeds) => {
        const refusal = unkeyedHook("MCP", feeds, authentication.principal !== undefined);

        return refusal === undefined ? Effect.void : Effect.die(new Error(refusal));
      });

/**
 * `base`, the 2026-07-28 adapter, also serving SEP-3415's `events/list`, `events/poll` and
 * `events/stream` for the event implementations of `serving`, and advertising the extension in
 * its discovery.
 */
export const withEvents = (base: Adapter, serving: Serving): Adapter => {
  const { authentication } = serving;

  const installHandlers = (core: Installing[0], lifecycle: Installing[1], target: Target) =>
    Effect.gen(function* () {
      const feeds = yield* acquireFeeds(serving.events);
      const built = yield* Effect.context<unknown>();

      const send = target.context.sendNotification;

      // Why: Every 2026-07-28 result names the server in its `_meta`, encoded per answer as
      // Effect's own handlers' results encode it, so a server information that does not encode
      // fails that answer rather than the forked installation, which no request would outwait.
      const meta = Effect.map(
        Effect.orDie(encodeServerInfo(target.context.serverInfo)),
        (serverInfo) => ({ "io.modelcontextprotocol/serverInfo": serverInfo }),
      );

      const delivery: EventDescriptor["delivery"] = [
        "poll",
        ...(send === undefined ? [] : ["push" as const]),
      ];

      const served = new Map(feeds.map((feed) => [feed.event.name, servedOf(feed, delivery)]));

      const servedNamed = (name: string) =>
        Option.match(Option.fromNullishOr(served.get(name)), {
          onNone: () =>
            Effect.fail(
              new EventsError({
                code: codes.notFound,
                message: `Unknown event: ${name}`,
                data: { kind: "event" },
              }),
            ),
          onSome: Effect.succeed,
        });

      // Why: A protected event runs as the identity the endpoint verified, as a protected tool's
      // call does, and a refusal asking to sign in or step up is answered as its 401 or 403.
      const asSubscriber = <A, E, R>(event: Event.Any, run: Effect.Effect<A, E, R>) =>
        authentication === undefined || event.caller === Anyone
          ? run
          : recordStepUp(promote(authentication, run));

      const fromBuilt = <A, E, R>(handled: Effect.Effect<A, E, R>) =>
        Effect.updateContext(handled, (request: Context.Context<never>) =>
          Context.merge(built, request),
        );

      const failingAsWire = <A, R>(run: Effect.Effect<A, unknown, R>) =>
        Effect.catchCause(run, (cause) => Effect.flatMap(wireErrorOf(cause), Effect.fail));

      const handlers = Requests.of({
        "events/list": () =>
          Effect.map(meta, (_meta) => ({
            resultType: "complete" as const,
            events: [...served.values()].map(({ listing }) => listing),
            _meta,
          })),
        "events/poll": ({ name, arguments: args, cursor, maxEvents }) =>
          Effect.gen(function* () {
            yield* routedTo(name);

            const { feed, decode, wire } = yield* servedNamed(name);
            const input = yield* decode(args);

            const { page, events } = yield* failingAsWire(
              Effect.gen(function* () {
                const page = yield* asSubscriber(
                  feed.event,
                  Effect.flatMap(principalOf(feed.event, authentication), (subscriber) =>
                    feed.poll(input, cursor ?? null, { subscriber, maxEvents }),
                  ),
                );

                return { page, events: yield* Effect.forEach(page.events, wire) };
              }),
            );

            return {
              resultType: "complete" as const,
              events,
              cursor: page.cursor,
              truncated: page.truncated,
              hasMore: page.hasMore,
              nextPollMs: Duration.toMillis(page.nextPoll),
              _meta: yield* meta,
            };
          }).pipe(fromBuilt),
        "events/stream": ({ name, arguments: args, cursor }, { client, requestId }) =>
          Effect.gen(function* () {
            yield* routedTo(name);

            const { feed, decode, wire } = yield* servedNamed(name);
            const input = yield* decode(args);

            if (send === undefined) {
              return yield* new EventsError({
                code: codes.unsupported,
                message: "This endpoint serves events by poll alone",
                data: { feature: "deliveryMode", value: "push" },
              });
            }

            return yield* delivered(
              { send, clientId: client.id, requestId, wire, _meta: yield* meta },
              (deliver) =>
                asSubscriber(
                  feed.event,
                  Effect.flatMap(feed.stream(input), (open) =>
                    pushed(open, cursor ?? null, deliver),
                  ),
                ),
            );
          }).pipe(fromBuilt),
      });

      yield* Effect.asVoid(
        base.installHandlers(core, lifecycle, {
          ...target,
          context: {
            ...target.context,
            serverInfo: {
              ...target.context.serverInfo,
              extensions: {
                ...target.context.serverInfo.extensions,
                [extension]: { listChanged: false },
              },
            },
          },
        }),
      );

      yield* target.install(base, Requests, handlers);
    });

  const adapter = {
    ...base,
    clientRpcs: groupOf(base, "clientRpcs").merge(Requests),
    handlerRpcs: groupOf(base, "handlerRpcs").merge(Requests),
    serverNotificationRpcs: groupOf(base, "serverNotificationRpcs").merge(Notifications),
    installHandlers,
  };

  return adapter;
};

/**
 * One push subscription, as `events/stream` holds it: what the feed's `pushed` sends, as
 * SEP-3415's notifications. Its confirmation is `active`, a later gap a fresh `active`, a
 * position a heartbeat, and a failure it reads on through `error`. A failure before `active` is
 * the request's error; a refusal after it ends the subscription with `terminated`.
 */
const delivered = (
  {
    send,
    clientId,
    requestId,
    wire,
    _meta: resultMeta,
  }: {
    readonly send: Send;
    readonly clientId: number;
    readonly requestId: RpcMessage.RequestId;
    readonly wire: (occurrence: Event.Occurrence<Event.Any>) => Effect.Effect<WireOccurrence>;
    readonly _meta: { readonly [key: string]: Schema.Json };
  },
  run: (deliver: (sent: Pushed) => Effect.Effect<void>) => Effect.Effect<void, unknown, unknown>,
) =>
  Effect.gen(function* () {
    const _meta = { [subscriptionIdKey]: requestId };
    let active = false;

    const notify = <N extends Notified>(rpc: N, payload: N["payloadSchema"]["Type"]) =>
      send("2026-07-28", clientId, { tag: rpc._tag, payload });

    const activate = (cursor: string | null, truncated: boolean) => {
      active = true;

      return notify(Active, { _meta, cursor, truncated });
    };

    const deliver = (sent: Pushed): Effect.Effect<void> =>
      Match.valueTags(sent, {
        Gap: ({ cursor }) => activate(cursor, true),
        Checked: ({ cursor }) =>
          active ? notify(Heartbeat, { _meta, cursor }) : activate(cursor, false),
        Occurrence: (occurrence) =>
          Effect.flatMap(wire(occurrence), (event) => notify(Occurred, { ...event, _meta })),
        Failed: () =>
          notify(FailedNotification, {
            _meta,
            error: { code: internalError.code, message: internalError.message },
          }),
      });

    const exit = yield* Effect.exit(run(deliver));

    if (Exit.isFailure(exit)) {
      if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt;

      const { code, message, data } = yield* wireErrorOf(exit.cause);

      if (!active) return yield* new EventsError({ code, message, data });

      yield* notify(Terminated, {
        _meta,
        error: { code, message, ...(data === undefined ? {} : { data }) },
      });
    }

    return { resultType: "complete" as const, _meta: { ...resultMeta, ..._meta } };
  });
