import {
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  Match,
  Option,
  Predicate,
  Result,
  Schema,
} from "effect";
import { McpSchema } from "effect/ai";
import type { McpProtocol } from "effect/ai";
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { Rpc, RpcGroup, RpcMessage } from "effect/rpc";

import { promote } from "../authentication/provider.js";
import type { Any as Authentication } from "../authentication/provider.js";
import { recordStepUp } from "../authentication/refusal.js";
import { inputParseOptions } from "../contract/call.js";
import { Anyone, principalOf } from "../contract/caller.js";
import { sentError } from "../contract/codes.js";
import * as Event from "../contract/Event.js";
import { acquireFeeds, unkeyedHook } from "../contract/feed.js";
import type { AnyEventImplementation, Feed } from "../contract/feed.js";
import { encodeUntaggedOf } from "../contract/occurrence.js";
import { pushed, refusalIn } from "../contract/push.js";
import type { Pushed } from "../contract/push.js";
import { reported } from "../contract/reported.js";
import {
  offersWebhook,
  servedWebhooks,
  Webhooks,
  webhookSubscriber,
} from "../contract/webhooks.js";
import type { Subscriber } from "../contract/webhooks.js";
import {
  Active,
  codes,
  EventsError,
  extension,
  Failed as FailedNotification,
  Heartbeat,
  Notifications,
  Occurred,
  Requests,
  subscriptionIdKey,
  Terminated,
} from "./events.js";
import type { EventDescriptor, PollEvents, WireOccurrence } from "./events.js";
import { isObjectSchema, routingFormsOf, toolJsonSchema } from "./protocol.js";

type Adapter = McpProtocol.ProtocolAdapter<
  "2026-07-28",
  McpProtocol.StatelessRuntimeDescriptor
>;

type Installing = Parameters<Adapter["installHandlers"]>;

type Send = (
  protocolVersion: string,
  clientId: number,
  notification: McpProtocol.ProjectedNotification
) => Effect.Effect<void>;

interface Target {
  readonly context: {
    readonly sendNotification?: Send | undefined;
    readonly serverInfo: Schema.Struct.Type<
      typeof McpSchema.Implementation.fields
    > & {
      readonly extensions?:
        | McpSchema.ServerCapabilities["extensions"]
        | undefined;
    };
  };
  readonly install: (
    protocol: { readonly protocolVersion: string },
    rpcs: typeof Requests,
    handlers: RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof Requests>>
  ) => Effect.Effect<void, never, unknown>;
}

const isGroup = (u: unknown): u is RpcGroup.RpcGroup<Rpc.AnyWithProps> =>
  Predicate.isObjectKeyword(u) &&
  "merge" in u &&
  Predicate.isFunction(u.merge) &&
  "requests" in u &&
  u.requests instanceof Map;

const groupOf = (
  adapter: Adapter,
  key: string
): RpcGroup.RpcGroup<Rpc.AnyWithProps> => {
  const group: unknown = Predicate.hasProperty(adapter, key)
    ? adapter[key]
    : undefined;

  if (!isGroup(group)) {
    throw new Error(
      `Effect's MCP ${adapter.protocolVersion} adapter holds no ${key} group: effect-actions supports MCP events on effect 4.0.x (install the effect version its peer range names)`
    );
  }

  return group;
};

export interface Serving {
  readonly events: readonly AnyEventImplementation[];
  readonly authentication: Authentication | undefined;
}

export const eventSchemasOf = (
  event: Event.Any
): Pick<EventDescriptor, "inputSchema" | "payloadSchema"> => {
  const inputSchema = toolJsonSchema(Schema.toCodecJson(event.input), true);

  if (!isObjectSchema(inputSchema)) {
    throw new Error(
      `MCP event input must be one object with keys, such as a struct: ${event.name} (wrap a union, an array or a scalar in a field, or omit input for no arguments)`
    );
  }

  const payloadSchema = toolJsonSchema(
    Schema.toCodecJson(event.payload),
    false
  );

  if (!isObjectSchema(payloadSchema)) {
    throw new Error(
      `MCP event payload must be one object, such as a struct: ${event.name} (wrap an array or a scalar in a field)`
    );
  }

  return { inputSchema, payloadSchema };
};

const encodeServerInfo = Schema.encodeEffect(McpSchema.Implementation);

type Notified = RpcGroup.Rpcs<typeof Notifications>;

const internalError = new EventsError({
  code: codes.internal,
  message: "Internal error",
});

const isSubscriptionError = Schema.is(Event.SubscriptionError);

const wireErrorOf = (
  cause: Cause.Cause<unknown>
): Effect.Effect<EventsError> => {
  const refusal = refusalIn(cause);

  if (refusal !== undefined) {
    return Effect.succeed(new EventsError(sentError(refusal)));
  }

  const failure = Cause.hasDies(cause)
    ? undefined
    : Result.getOrUndefined(Cause.findFail(cause));

  return isSubscriptionError(failure?.error)
    ? Effect.succeed(new EventsError(sentError(failure.error)))
    : Effect.as(reported(cause), internalError);
};

const headerMismatch = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.andThen(
    HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.succeed(HttpServerResponse.setStatus(response, 400))
    ).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request)),
    Effect.fail(
      new EventsError({
        code: codes.headerMismatch,
        message: "Mcp-Name header does not match request parameters",
      })
    )
  );

const routedTo = (name: string) =>
  Effect.flatMap(
    Effect.serviceOption(HttpServerRequest.HttpServerRequest),
    (request) =>
      Option.isNone(request) ||
      routingFormsOf(name).includes(request.value.headers["mcp-name"] ?? "")
        ? Effect.void
        : headerMismatch(request.value)
  );

type Arguments = (typeof PollEvents.payloadSchema.Type)["arguments"];

interface Served {
  readonly feed: Feed;
  readonly decode: (
    args: Arguments
  ) => Effect.Effect<Event.Any["input"]["Type"], EventsError>;
  readonly wire: (
    occurrence: Event.Occurrence<Event.Any>
  ) => Effect.Effect<WireOccurrence>;
  readonly listing: EventDescriptor;
}

const servedOf = (
  feed: Feed,
  delivery: EventDescriptor["delivery"]
): Served => {
  const { event } = feed;

  const decode = Schema.decodeUnknownEffect(
    Schema.toCodecJson(event.input),
    inputParseOptions
  );

  return {
    feed,
    decode: (args) =>
      Effect.mapError(
        decode(args ?? {}),
        ({ message }) =>
          new EventsError({
            code: codes.invalidParams,
            message: `Invalid arguments for event '${event.name}': ${message}`,
          })
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

export const refuseUnservable = ({
  events,
  authentication,
}: Serving): Effect.Effect<void, never, unknown> =>
  authentication === undefined
    ? Effect.void
    : Effect.flatMap(acquireFeeds(events), (feeds) => {
        const refusal = unkeyedHook(
          "MCP",
          feeds,
          authentication.principal !== undefined
        );

        return refusal === undefined
          ? Effect.void
          : Effect.die(new Error(refusal));
      });

export const serveWebhooks = (
  serving: Serving
): Effect.Effect<void, never, unknown> =>
  Effect.asVoid(
    Effect.flatMap(acquireFeeds(serving.events), (feeds) =>
      servedWebhooks(feeds, serving.authentication)
    )
  );

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
    readonly wire: (
      occurrence: Event.Occurrence<Event.Any>
    ) => Effect.Effect<WireOccurrence>;
    readonly _meta: { readonly [key: string]: Schema.Json };
  },
  run: (
    deliver: (sent: Pushed) => Effect.Effect<void>
  ) => Effect.Effect<void, unknown, unknown>
) => {
  const notify = <N extends Notified>(
    rpc: N,
    payload: N["payloadSchema"]["Type"]
  ) => send("2026-07-28", clientId, { tag: rpc._tag, payload });

  return Effect.gen(function* () {
    const _meta = { [subscriptionIdKey]: requestId };
    let active = false;

    const activate = (cursor: string | null, truncated: boolean) => {
      active = true;

      return notify(Active, { _meta, cursor, truncated });
    };

    const deliver = (sent: Pushed): Effect.Effect<void> =>
      Match.valueTags(sent, {
        Gap: ({ cursor }) => activate(cursor, true),
        Checked: ({ cursor }) =>
          active
            ? notify(Heartbeat, { _meta, cursor })
            : activate(cursor, false),
        Occurrence: (occurrence) =>
          Effect.flatMap(wire(occurrence), (event) =>
            notify(Occurred, { ...event, _meta })
          ),
        Failed: () =>
          notify(FailedNotification, {
            _meta,
            error: { code: internalError.code, message: internalError.message },
          }),
      });

    const exit = yield* Effect.exit(run(deliver));

    if (Exit.isFailure(exit)) {
      if (Cause.hasInterruptsOnly(exit.cause)) {
        return yield* Effect.interrupt;
      }

      const error = yield* wireErrorOf(exit.cause);

      if (!active) {
        return yield* error;
      }

      const { code, message, data } = error;

      yield* notify(Terminated, {
        _meta,
        error: { code, message, ...(data === undefined ? {} : { data }) },
      });
    }

    return {
      resultType: "complete" as const,
      _meta: { ...resultMeta, ..._meta },
    };
  });
};

export const withEvents = (base: Adapter, serving: Serving): Adapter => {
  const { authentication } = serving;

  const asSubscriber = <A, E, R>(
    event: Event.Any,
    run: Effect.Effect<A, E, R>
  ) =>
    authentication === undefined || event.caller === Anyone
      ? run
      : recordStepUp(promote(authentication, run));

  const installHandlers = (
    core: Installing[0],
    lifecycle: Installing[1],
    target: Target
  ) =>
    Effect.gen(function* () {
      const feeds = yield* acquireFeeds(serving.events);
      const built = yield* Effect.context<unknown>();

      const send = target.context.sendNotification;

      const meta = Effect.map(
        Effect.orDie(encodeServerInfo(target.context.serverInfo)),
        (serverInfo) => ({ "io.modelcontextprotocol/serverInfo": serverInfo })
      );

      const webhooks = Context.getOption(built, Webhooks);

      const webhookOffered = (event: Event.Any) =>
        Option.isSome(webhooks) && offersWebhook(event, authentication);

      const deliveryOf = (event: Event.Any): EventDescriptor["delivery"] => [
        "poll",
        ...(send === undefined ? [] : ["push" as const]),
        ...(webhookOffered(event) ? ["webhook" as const] : []),
      ];

      const served = new Map(
        feeds.map((feed) => [
          feed.event.name,
          servedOf(feed, deliveryOf(feed.event)),
        ])
      );

      const servedNamed = (name: string) => {
        const found = served.get(name);

        return found === undefined
          ? Effect.fail(
              new EventsError(
                sentError(
                  Event.SubscriptionError.of(name, new Event.NotServed())
                )
              )
            )
          : Effect.succeed(found);
      };

      const asWebhook = <A, R>(
        feed: Feed,
        run: (subscriber: Subscriber) => Effect.Effect<A, unknown, R>
      ) =>
        Effect.catchCause(
          asSubscriber(
            feed.event,
            Effect.flatMap(
              webhookSubscriber(feed, authentication, webhooks),
              run
            )
          ),
          (cause) => Effect.flatMap(wireErrorOf(cause), Effect.fail)
        );

      const fromBuilt = <A, E, R>(handled: Effect.Effect<A, E, R>) =>
        Effect.updateContext(handled, (request: Context.Context<never>) =>
          Context.merge(built, request)
        );

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

            const { page, events } = yield* Effect.gen(function* () {
              const polled = yield* asSubscriber(
                feed.event,
                Effect.flatMap(
                  principalOf(feed.event, authentication),
                  (subscriber) =>
                    feed.poll(input, cursor ?? null, { subscriber, maxEvents })
                )
              );

              return {
                page: polled,
                events: yield* Effect.forEach(polled.events, wire),
              };
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.flatMap(wireErrorOf(cause), Effect.fail)
              )
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
        "events/stream": (
          { name, arguments: args, cursor },
          { client, requestId }
        ) =>
          Effect.gen(function* () {
            yield* routedTo(name);

            const { feed, decode, wire } = yield* servedNamed(name);
            const input = yield* decode(args);

            if (send === undefined) {
              return yield* new EventsError(
                sentError(
                  Event.SubscriptionError.of(
                    name,
                    new Event.Unsupported({
                      feature: "deliveryMode",
                      value: "push",
                    })
                  )
                )
              );
            }

            return yield* delivered(
              {
                send,
                clientId: client.id,
                requestId,
                wire,
                _meta: yield* meta,
              },
              (deliver) =>
                asSubscriber(
                  feed.event,
                  Effect.flatMap(feed.stream(input), (open) =>
                    pushed(open, cursor ?? null, deliver)
                  )
                )
            );
          }).pipe(fromBuilt),
        "events/subscribe": ({
          name,
          arguments: args,
          delivery: { url, secret },
          cursor,
          ttlMs,
        }) =>
          Effect.gen(function* () {
            yield* routedTo(name);

            const { feed, decode } = yield* servedNamed(name);
            const input = yield* decode(args);

            const grant = yield* asWebhook(
              feed,
              ({ webhooks: service, ...subscriber }) =>
                service.subscribe({
                  ...subscriber,
                  input,
                  delivery: { url, secret },
                  cursor: cursor ?? null,
                  ttlMs,
                })
            );

            return {
              resultType: "complete" as const,
              ...grant,
              _meta: yield* meta,
            };
          }).pipe(fromBuilt),
        "events/unsubscribe": ({ name, arguments: args, delivery }) =>
          Effect.gen(function* () {
            yield* routedTo(name);

            const { feed, decode } = yield* servedNamed(name);
            const input = yield* decode(args);

            yield* asWebhook(
              feed,
              ({ webhooks: service, feed: subscribed, principal }) =>
                service.unsubscribe({
                  feed: subscribed,
                  principal,
                  input,
                  delivery,
                })
            );

            return { resultType: "complete" as const, _meta: yield* meta };
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
        })
      );

      yield* target.install(base, Requests, handlers);
    });

  const adapter = {
    ...base,
    clientRpcs: groupOf(base, "clientRpcs").merge(Requests),
    handlerRpcs: groupOf(base, "handlerRpcs").merge(Requests),
    serverNotificationRpcs: groupOf(base, "serverNotificationRpcs").merge(
      Notifications
    ),
    installHandlers,
  };

  return adapter;
};
