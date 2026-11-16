import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster";
import { ClusterEntity } from "@effect/platform-cloudflare/CloudflareDurableObjects";
import * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as Stored from "@gjermundgaraba/effect-actions/Stored";
import { Effect, Predicate } from "effect";
import type { Context, Schema, Stream } from "effect";
import type { Sharding } from "effect/cluster";

import { pingPong, replyToClose } from "./frames.js";
import { makeSockets } from "./sockets.js";
import type { Served } from "./sockets.js";

/** `make`'s options. */
export interface Options<Env> {
  /**
   * The function `CloudflareDurableObjects.setInitializer` returned, whose cluster the host
   * forwards each socket's calls through.
   */
  readonly initialize: (
    env: Env
  ) => PromiseLike<Context.Context<Sharding.Sharding>>;
  /** The entities whose objects accept sockets: an upgrade to an object of another entity type is answered 404. */
  readonly sockets: readonly ActionEntity.Any[];
  /** The version a page's upgrade names, every other refused with a close; without it, every upgrade is accepted. */
  readonly protocol?:
    | {
        /** The version served, which a page names in its socket's URL as `?protocol=<version>`. */
        readonly version: string;
        /** The close code of a refusal, an integer from 4000 to 4999, which `ActionRpc.reconnectUntil(code)` stops at; another throws as the class is made. */
        readonly code: number;
        /** The close reason, at most 123 bytes UTF-8 encoded; by default `This server speaks protocol <version>: reload the page`. A longer one throws as the class is made. */
        readonly reason?: string | undefined;
      }
    | undefined;
}

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

const refusalOf = (protocol: Options<unknown>["protocol"]) => {
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
      `ActionClusterEntity.make's protocol.code ${code} is not an integer from 4000 to 4999, the codes a watch ends at (give one of those)`
    );
  }

  if (bytesOf(reason) > closeReasonBytes) {
    throw new Error(
      `ActionClusterEntity.make's protocol.reason, given or the default naming its version, is ${bytesOf(reason)} bytes, more than the ${closeReasonBytes} a close frame holds (give a reason of at most ${closeReasonBytes} bytes, UTF-8 encoded)`
    );
  }

  return { version, code, reason };
};

interface Bound {
  readonly byType: ReadonlyMap<string, ActionEntity.Any>;
  readonly refusal: ReturnType<typeof refusalOf>;
}

type Method = (
  payload: Schema.Json,
  options: { readonly headers: ReadonlyArray<readonly [string, string]> }
) => Effect.Effect<Schema.Json, unknown> | Stream.Stream<Schema.Json, unknown>;

type ClientFor = (
  entityId: string
) => Readonly<Record<string, Method | undefined>>;

const servingOf = (
  entity: ActionEntity.Any,
  context: Context.Context<Sharding.Sharding>
): ((entityId: string) => Served) => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const clientFor = Effect.runSync(
    Effect.provideContext(entity.client, context)
  ) as ClientFor;

  const rpcs = ActionEntity.bindingRpcs(entity).requests;

  const polls = new Set(
    entity.binding.events.map(({ name }) => ActionRpc.pollTag(name))
  );

  const releases = new Set(
    entity.binding.events.map(({ name }) => ActionRpc.releaseTag(name))
  );

  return (entityId) => ({
    rpcs,
    polls,
    releases,
    call: (tag, payload, headers) =>
      Effect.suspend(() => {
        const answer = clientFor(entityId)[tag]?.(payload, { headers });

        return Effect.isEffect(answer)
          ? answer
          : Effect.die(
              new Error(`ActionClusterEntity: ${tag} is no unary rpc`)
            );
      }).pipe(
        Effect.catchIf(ActionEntity.isClusterFailure, Effect.die),
        Effect.exit
      ),
  });
};

const hostOf = (
  ctx: DurableObjectState,
  context: Context.Context<Sharding.Sharding>,
  { byType, refusal }: Bound,
  waitUntil: (promise: Promise<unknown>) => void
) => {
  const serving = new Map<string, (entityId: string) => Served>();

  const servedBy = (name: string): Served | undefined => {
    const address = CloudflareCluster.decodeName(name);
    const entity = address === undefined ? undefined : byType.get(address.type);

    if (address === undefined || entity === undefined) {
      return undefined;
    }

    const served = serving.get(entity.type) ?? servingOf(entity, context);

    serving.set(entity.type, served);

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
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return new Response(
          "Expected a WebSocket upgrade: connect with a WebSocket client, or forward the page's own Request to the object",
          { status: 426 }
        );
      }

      const { name } = ctx.id;

      if (name === undefined || servedBy(name) === undefined) {
        return new Response(
          "This object serves no sockets: give its entity to ActionClusterEntity.make's sockets",
          { status: 404 }
        );
      }

      const { 0: client, 1: server } = new WebSocketPair();

      if (
        refusal !== undefined &&
        new URL(request.url).searchParams.get("protocol") !== refusal.version
      ) {
        server.accept();
        server.close(refusal.code, refusal.reason);

        return new Response(null, { status: 101, webSocket: client });
      }

      if (
        !sockets.accept(
          server,
          name,
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
 * The Durable Object `make`'s class builds: Effect's own `ClusterEntity`, with the WebSocket
 * handlers serving `sockets`. Exported as a type alone, to name the class in a Worker's
 * declarations; a subclass of `make`'s class overrides a WebSocket handler by calling `super`.
 */
class Host<Env> extends ClusterEntity {
  #host!: ReturnType<typeof hostOf>;

  constructor(
    ctx: DurableObjectState,
    env: Env,
    initialize: Options<Env>["initialize"],
    bound: Bound
  ) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(pingPong());

    Object.defineProperty(this, "fetch", {
      value: (request: Request) => this.#host.upgrade(request),
    });

    void ctx.blockConcurrencyWhile(async () => {
      const waitUntil = ctx.waitUntil.bind(ctx);
      const host = hostOf(ctx, await initialize(env), bound, waitUntil);

      ctx.waitUntil = (promise) => {
        waitUntil(promise);
        void promise.then(host.settled, host.settled);
      };

      this.#host = host;
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

/**
 * A Durable Object class to export from the Worker as `ClusterEntity`, in place of Effect's own:
 * a subclass of it, so every entity of the cluster runs on it, and it serves Effect RPC over
 * WebSockets, which the runtime holds while the object hibernates, for the entities of `sockets`.
 * The Worker hands a page's upgrade to the entity's object, `getByName(CloudflareCluster.encodeName(type, id)).fetch(request)`; each call
 * on the socket is forwarded into that entity through `Entity.client`, with the upgrade's
 * headers `ActionEntity.forwardedHeaders` keeps under its own, its own winning, and answered as
 * the entity answers it. A page calls with `ActionRpc.client(binding)`, watching with `mode: "poll"`,
 * over `RpcClient.layerProtocolSocket` and `RpcSerialization.layerJson`. Guide: `docs/ActionClusterEntity.md` in this package.
 *
 * **Gotchas**
 *
 * - A watch's poll that finds nothing new, on a page `notified`, is parked in the socket's attachment and asked again once `Stored.layerEvents`' change signal moved, read as each handler the object runs ends, whether a call, a tell or an alarm ran it: an entity whose events are not on `Stored.layerEvents`, and a check source not `notified`, have their polls answered at once, their watches polling at `nextPoll`, each poll a stub call.
 * - A post a socket watches, by a handler that sends no calls or tells, costs 1 + P stub calls, `invoke` each: the post, and one for each of the P polls parked on that object, sent as it settles; the page's client polls again `nextPoll` later, and that poll is parked with no call when nothing changed meanwhile and the last poll's call was under 30 seconds earlier, so a source whose `nextPoll` is 30 seconds or more costs one call a page each `nextPoll`.
 * - An `emit` stream's append, which no handler runs, moves the change signal but is read only when the object's next handler ends; a change a `notified` check source reads from an upstream, which no handler `notify`s, moves no signal at all, so a parked poll answers it only when its client sends it again, `ActionRpc.pollResentAfter` after it was sent: `notify` the source from a handler, or leave it not `notified`, to answer it at `nextPoll`.
 * - A source's subscription hook is held by the entity's activation until its `lease`, 5 minutes by default, after the last poll the host sent the entity, on a timer that keeps the object awake, so the object of a page watching a hooked source does not hibernate until the hook lapses: the host sends a page's poll at most 4 minutes 30 seconds after its last, or `nextPoll` after its last answer when that is longer, so a `lease` under 4 minutes 30 seconds may lapse while a poll is parked, and one not longer than its `nextPoll`, as the default is at a `nextPoll` of 5 minutes, may lapse after each answered page; a lapsed hook is set up again by the next poll the host sends the entity.
 * - Only the binding's actions and event types are forwarded: a native rpc, which authenticates nothing, and a streaming action, whose frames would hold the object awake, each fail the call with a defect naming it.
 * - A call under way is interrupted, through Effect's own interrupt to the entity, when the page interrupts it, as `Effect.timeout` does, or its socket closes or fails; a frame the host cannot read is answered with Effect's `Defect`, which fails the page's calls under way on that socket, though each runs on in the entity to its end.
 * - A call under way when the object is evicted, by a deploy, a crash or `evictDurableObject`, is lost: the next instance closes that socket with 1012, and the page's client connects again and polls from its cursor; a message on a socket whose attachment the object cannot read, as after a deploy changing it, closes it with 1012 the same way, and a parked poll whose event type the deploy removed is answered `Unknown request tag`, as a call of it is, once the object next settles.
 * - The upgrade's headers, cookies included, are each call's credentials, and the host judges no `Origin`: refuse a page of another site, or keep cookies off the socket, in the Worker, before it hands the upgrade to the object, as in an `ActionCluster.handler` socket route's `id`, which reads the request.
 * - The upgrade's headers, the calls under way and the parked polls, each with the headers its message sent, share the runtime's 16 KiB attachment: an upgrade past it is answered 431, and a call past it fails with a defect naming it.
 * - The runtime answers the page's pings itself, so an open page does not wake the object, and the host answers a page's close with its code and reason; a request that is no upgrade is answered 426, an upgrade to an object of an entity type not in `sockets` 404.
 */
export const make = <Env>(
  options: Options<Env>
): new (ctx: DurableObjectState, env: Env) => Host<Env> => {
  const { initialize } = options;

  const bound: Bound = {
    refusal: refusalOf(options.protocol),
    byType: new Map(
      options.sockets.map((entity) => [entity.type, entity] as const)
    ),
  };

  return class extends Host<Env> {
    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env, initialize, bound);
    }
  };
};

export type { Host };
