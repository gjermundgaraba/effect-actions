import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { Effect, Layer, Schedule, Schema } from "effect";
import type { Context } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

export const objectOf = (type: string, id: string) =>
  env.CLUSTER_ENTITY.getByName(CloudflareCluster.encodeName(type, id));

export const upgrade = (
  type: string,
  id: string,
  headers: Record<string, string> = {},
  version = "1"
) =>
  Effect.promise(
    async () =>
      await exports.default.fetch(
        `https://worker.example/sockets/${type}/${id}?protocol=${version}`,
        { headers: { ...headers, upgrade: "websocket" } }
      )
  );

export const opened = (
  type: string,
  id: string,
  headers: Record<string, string> = {},
  version = "1"
) =>
  Effect.gen(function* () {
    const response = yield* upgrade(type, id, headers, version);
    const socket = response.webSocket;

    if (socket === null) {
      return yield* Effect.die(new Error(`No WebSocket: ${response.status}`));
    }

    socket.accept();

    const closed: Array<{ readonly code: number; readonly reason: string }> =
      [];

    socket.addEventListener("close", ({ code, reason }) => {
      closed.push({ code, reason });
    });

    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket({
        retryPolicy: ActionRpc.reconnectUntil(4000, 1012),
      }).pipe(
        Layer.provide(
          Layer.effect(Socket.Socket)(
            Socket.fromWebSocket(Effect.succeed(socket))
          )
        ),
        Layer.provide(RpcSerialization.layerJson)
      )
    );

    return { socket, protocol, closed };
  });

export const reconnecting = (type: string, id: string) =>
  Layer.build(
    RpcClient.layerProtocolSocket({
      retryPolicy: ActionRpc.reconnectUntil(4000),
    }).pipe(
      Layer.provide(
        Layer.effect(Socket.Socket)(
          Socket.fromWebSocket(
            Effect.acquireRelease(
              Effect.flatMap(upgrade(type, id), (response) => {
                const socket = response.webSocket;

                if (socket === null) {
                  return Effect.die(
                    new Error(`No WebSocket: ${response.status}`)
                  );
                }

                socket.accept();

                return Effect.succeed(socket);
              }),
              (socket) =>
                Effect.sync(() => {
                  socket.close(1000);
                })
            )
          )
        )
      ),
      Layer.provide(RpcSerialization.layerJson)
    )
  );

export const clientOver = <B extends ActionRpc.Any>(
  binding: B,
  socket: { readonly protocol: Context.Context<RpcClient.Protocol> }
) =>
  ActionRpc.client(binding, { delivery: "poll" }).pipe(
    Effect.provideContext(socket.protocol)
  );

export const evict = (type: string, id: string) =>
  Effect.promise(async () => {
    await evictDurableObject(objectOf(type, id));
  });

export const evictIfRunning = (type: string, id: string) =>
  Effect.promise(async () => {
    await evictDurableObject(objectOf(type, id)).catch((error: unknown) => {
      if (
        !(error instanceof Error) ||
        !error.message.includes("it is not currently running")
      ) {
        throw error;
      }
    });
  });

const Held = Schema.Struct({
  calls: Schema.Array(Schema.Unknown),
  parked: Schema.Array(Schema.Unknown),
});

const decodeHeld = Schema.decodeUnknownSync(Schema.Array(Held));

export const heldIn = (type: string, id: string) =>
  Effect.promise(
    async () =>
      await runInDurableObject(objectOf(type, id), (_, state) =>
        decodeHeld(
          state
            .getWebSockets()
            .map((socket): unknown => socket.deserializeAttachment())
        )
      )
  );

export const watchingIn = (type: string, id: string, sockets: number) =>
  heldIn(type, id).pipe(
    Effect.repeat({
      until: (held) =>
        held.length === sockets &&
        held.every(
          ({ calls, parked }) => calls.length === 0 && parked.length === 1
        ),
      schedule: Schedule.spaced("100 millis"),
    }),
    Effect.timeout("20 seconds")
  );

const Counts = Schema.Struct({
  invoke: Schema.Int,
  hold: Schema.Int,
  acknowledge: Schema.Int,
});

const Stubs = Schema.Struct({
  started: Counts,
  finished: Counts,
  instances: Schema.Array(Schema.String),
});

export const stubs = Effect.promise(
  async () =>
    await exports.default
      .fetch("https://worker.example/stubs")
      .then(async (response) => await response.json())
).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Stubs)), Effect.orDie);
