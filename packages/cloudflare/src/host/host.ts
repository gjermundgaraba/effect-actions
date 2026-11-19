import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster";
import * as CloudflareDurableObjects from "@effect/platform-cloudflare/CloudflareDurableObjects";
import type * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import type * as Event from "@gjermundgaraba/effect-actions/Event";
import * as Stored from "@gjermundgaraba/effect-actions/Stored";
import { Effect, Predicate } from "effect";
import type { Context, Schema, Stream } from "effect";
import type { Sharding } from "effect/cluster";
import { RpcSchema } from "effect/rpc";
import type { Rpc } from "effect/rpc";

import { hold, listen } from "../cluster/objects.js";
import type * as ActionWorker from "./ActionWorker.js";
import { pingPong, replyToClose } from "./frames.js";
import { makeSockets } from "./sockets.js";
import type { Refusal, Served } from "./sockets.js";

/** One entity whose objects accept sockets, with what they serve and the version they speak. */
export type Exposed = Pick<ActionWorker.Socket, "actions" | "protocol"> & {
  readonly entity: ActionEntity.Any;
};

/** Whether `request` asks for a WebSocket upgrade. */
export const isUpgrade = (request: Request) =>
  request.headers.get("upgrade")?.toLowerCase() === "websocket";

const gateOf = (sql: SqlStorage) => () => {
  try {
    const { signal } = sql.exec(Stored.changeSignal).one();

    return Predicate.isNumber(signal) ? signal : undefined;
  } catch (error) {
    if (error instanceof Error && error.message.includes("no such table")) {
      return undefined;
    }

    throw error;
  }
};

const closeReasonBytes = 123;

const bytesOf = (text: string) => new TextEncoder().encode(text).byteLength;

const refusalOf = (
  type: string,
  protocol: Exposed["protocol"]
): Refusal | undefined => {
  if (protocol === undefined) {
    return undefined;
  }

  const {
    version,
    code,
    reason = `This server speaks protocol ${version}: reload the page`,
  } = protocol;

  if (!Number.isInteger(code) || code < 4000 || code > 4999) {
    throw new Error(
      `ActionWorker.make: the socket of ${type} has protocol.code ${code} is not an integer from 4000 to 4999, the codes a watch ends at (give one of those)`
    );
  }

  if (bytesOf(reason) > closeReasonBytes) {
    throw new Error(
      `ActionWorker.make: the socket of ${type} has a protocol.reason, given or the default naming its version, that is ${bytesOf(reason)} bytes, more than the ${closeReasonBytes} a close frame holds (give a reason of at most ${closeReasonBytes} bytes, UTF-8 encoded)`
    );
  }

  return { version, code, reason };
};

interface Exposure {
  readonly entity: ActionEntity.Any;
  readonly rpcs: ReadonlyMap<string, Rpc.AnyWithProps>;
  readonly polls: ReadonlySet<string>;
  readonly refusal: Refusal | undefined;
}

const exposureOf = ({ entity, actions, protocol }: Exposed): Exposure => {
  const { binding, type } = entity;

  const bound = new Set<Action.Any | Event.Any>([
    ...binding.actions,
    ...binding.events,
  ]);

  const unbound = (actions ?? []).filter((contract) => !bound.has(contract));

  if (unbound.length > 0) {
    throw new Error(
      `ActionWorker.make: the socket of ${type} lists ${unbound.map(({ name }) => name).join(", ")}, which ${type}'s binding does not hold (list only its binding's actions and event types)`
    );
  }

  const listed = new Set(actions ?? bound);
  const served = binding.actions.filter((action) => listed.has(action));
  const events = binding.events.filter((event) => listed.has(event));
  const rpcs = ActionEntity.bindingRpcs(entity).requests;

  const streamed =
    actions === undefined
      ? []
      : served.filter(({ name }) => {
          const rpc = rpcs.get(name);

          return (
            rpc !== undefined && RpcSchema.isStreamSchema(rpc.successSchema)
          );
        });

  if (streamed.length > 0) {
    throw new Error(
      `ActionWorker.make: the socket of ${type} lists ${streamed.map(({ name }) => name).join(", ")}, a streaming action, which a socket does not serve, since its frames would hold the object awake (call it over HTTP through ActionEntity.reaching)`
    );
  }

  const polls = new Set(events.map(({ name }) => ActionRpc.pollTag(name)));

  const tags = new Set([...served.map(({ name }) => name), ...polls]);

  return {
    entity,
    rpcs: new Map([...rpcs].filter(([tag]) => tags.has(tag))),
    polls,
    refusal: refusalOf(type, protocol),
  };
};

type Method = (
  payload: Schema.Json,
  options: { readonly headers: ReadonlyArray<readonly [string, string]> }
) => Effect.Effect<Schema.Json, unknown> | Stream.Stream<Schema.Json, unknown>;

type ClientFor = (
  entityId: string
) => Readonly<Record<string, Method | undefined>>;

const servingOf = (
  { entity, rpcs, polls, refusal }: Exposure,
  context: Context.Context<Sharding.Sharding>
): ((entityId: string) => Served) => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const clientFor = Effect.runSync(
    Effect.provideContext(entity.client, context)
  ) as ClientFor;

  return (entityId) => ({
    rpcs,
    polls,
    refusal,
    call: (tag, payload, headers) =>
      Effect.suspend(() => {
        const answer = clientFor(entityId)[tag]?.(payload, { headers });

        return Effect.isEffect(answer)
          ? answer
          : Effect.die(new Error(`ActionWorker: ${tag} is no unary rpc`));
      }).pipe(
        Effect.catchIf(ActionEntity.isClusterFailure, Effect.die),
        Effect.exit
      ),
  });
};

const hostOf = (
  ctx: DurableObjectState,
  context: Context.Context<Sharding.Sharding>,
  byType: ReadonlyMap<string, Exposure>,
  waitUntil: (promise: Promise<unknown>) => void
) => {
  const serving = new Map<string, (entityId: string) => Served>();

  const servedBy = (name: string): Served | undefined => {
    const address = CloudflareCluster.decodeName(name);

    const exposure =
      address === undefined ? undefined : byType.get(address.type);

    if (address === undefined || exposure === undefined) {
      return undefined;
    }

    const served = serving.get(address.type) ?? servingOf(exposure, context);

    serving.set(address.type, served);

    return served(address.id);
  };

  const sockets = makeSockets({
    servedBy,
    gate: gateOf(ctx.storage.sql),
    now: Date.now,
    sockets: () => ctx.getWebSockets(),
    waitUntil,
  });

  return {
    ...sockets,
    upgrade: (request: Request): Response => {
      if (!isUpgrade(request)) {
        return new Response(
          "Expected a WebSocket upgrade: connect with a WebSocket client, or forward the page's own Request to the object",
          { status: 426 }
        );
      }

      const { name } = ctx.id;
      const served = name === undefined ? undefined : servedBy(name);

      if (name === undefined || served === undefined) {
        return new Response(
          "This object serves no sockets: give its entity a socket in ActionWorker.make's entities",
          { status: 404 }
        );
      }

      const { 0: client, 1: server } = new WebSocketPair();
      const version = new URL(request.url).searchParams.get("protocol");
      const { refusal } = served;

      if (refusal !== undefined && version !== refusal.version) {
        server.accept();
        server.close(refusal.code, refusal.reason);

        return new Response(null, { status: 101, webSocket: client });
      }

      if (
        !sockets.accept(
          server,
          name,
          version,
          Object.entries(ActionEntity.forwardedHeaders(request.headers))
        )
      ) {
        return new Response(
          "The headers a socket keeps exceed its attachment: send fewer or smaller cookies to this path, or the token on each message",
          { status: 431 }
        );
      }

      ctx.acceptWebSocket(server);

      return new Response(null, { status: 101, webSocket: client });
    },
  };
};

/**
 * The Durable Object class `ActionWorker.make` returns as `ClusterEntity`: Effect's own
 * `ClusterEntity`, recording each object's state for `ActionCluster.ObjectState`, with the
 * WebSocket handlers serving its entities' sockets. A subclass overrides a WebSocket handler by
 * calling `super`, and not `fetch`, which Effect's class types as `() => never`.
 */
export class Host<Env> extends CloudflareDurableObjects.ClusterEntity {
  #host!: ReturnType<typeof hostOf>;

  constructor(
    ctx: DurableObjectState,
    env: Env,
    context: (env: Env) => PromiseLike<Context.Context<Sharding.Sharding>>,
    byType: ReadonlyMap<string, Exposure>
  ) {
    super(ctx, env);
    hold(ctx);
    ctx.setWebSocketAutoResponse(pingPong());

    Object.defineProperty(this, "fetch", {
      value: (request: Request) => this.#host.upgrade(request),
      writable: true,
      configurable: true,
    });

    void ctx.blockConcurrencyWhile(async () => {
      const waitUntil = ctx.waitUntil.bind(ctx);
      const host = hostOf(ctx, await context(env), byType, waitUntil);

      ctx.waitUntil = (promise) => {
        waitUntil(promise);
        void promise.then(host.settled, host.settled);
      };

      this.#host = host;
      listen(ctx, () => {
        setTimeout(host.settled, 0);
      });
      host.started();
    });
  }

  override async webSocketMessage(
    socket: WebSocket,
    data: string | ArrayBuffer
  ): Promise<void> {
    await Effect.runPromise(this.#host.message(socket, data));
  }

  override async webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string
  ): Promise<void> {
    replyToClose(socket, code, reason);
    await Effect.runPromise(this.#host.closed(socket));
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    await Effect.runPromise(this.#host.closed(socket));
  }
}

/** What each entity's socket serves, by its type, checked at once: a misconfigured socket throws. */
export const exposuresOf = (
  exposed: readonly Exposed[]
): ReadonlyMap<string, Exposure> =>
  new Map(
    exposed.map((socket) => [socket.entity.type, exposureOf(socket)] as const)
  );

/** The `ClusterEntity` class serving the sockets of `byType`, each forwarded through the cluster of `context`. */
export const hostClass = <Env>(
  byType: ReadonlyMap<string, Exposure>,
  context: (env: Env) => PromiseLike<Context.Context<Sharding.Sharding>>
): new (ctx: DurableObjectState, env: Env) => Host<Env> =>
  class extends Host<Env> {
    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env, context, byType);
    }
  };
