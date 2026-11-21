import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { Effect, Layer, Predicate, Schedule, Schema } from "effect";
import type { Context } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import { eventually } from "./eventually.js";

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

const closing = (socket: WebSocket) =>
  Effect.sync(() => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(1000);
    }
  });

export const connected = (response: Response) =>
  Effect.gen(function* () {
    const socket = yield* Effect.acquireRelease(
      response.webSocket === null
        ? Effect.die(new Error(`No WebSocket: ${response.status}`))
        : Effect.succeed(response.webSocket),
      closing
    );

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

export const opened = (
  type: string,
  id: string,
  headers: Record<string, string> = {},
  version = "1"
) => Effect.flatMap(upgrade(type, id, headers, version), connected);

export const raw = (type: string, id: string) =>
  Effect.acquireRelease(
    Effect.flatMap(upgrade(type, id), ({ status, webSocket }) => {
      if (webSocket === null) {
        return Effect.die(new Error(`No WebSocket: ${status}`));
      }

      const received: string[] = [];
      const closed: number[] = [];

      webSocket.addEventListener("message", ({ data }) => {
        received.push(String(data));
      });
      webSocket.addEventListener("close", ({ code }) => {
        closed.push(code);
      });
      webSocket.accept();

      return Effect.succeed({ socket: webSocket, received, closed });
    }),
    ({ socket }) => closing(socket)
  );

export const pollOf =
  (socket: WebSocket, event: string, board: string) =>
  (
    id: string,
    watch: string,
    cursor: string | null,
    headers: ReadonlyArray<readonly [string, string]> = []
  ) => {
    socket.send(
      JSON.stringify({
        _tag: "Request",
        id,
        tag: ActionRpc.pollTag(event),
        payload: { input: { board }, cursor, watch },
        headers,
      })
    );
  };

export const answeredEarlier = (
  type: string,
  id: string,
  watch: string,
  millis: number
) =>
  Effect.promise(async () => {
    await runInDurableObject(objectOf(type, id), (_, state) => {
      for (const held of state.getWebSockets()) {
        const attachment: unknown = held.deserializeAttachment();

        if (
          Predicate.isObject(attachment) &&
          Array.isArray(attachment["answered"])
        ) {
          held.serializeAttachment({
            ...attachment,
            answered: attachment["answered"].map((answer: unknown) =>
              Predicate.isObject(answer) &&
              answer["watch"] === watch &&
              Predicate.isNumber(answer["at"])
                ? { ...answer, at: answer["at"] - millis }
                : answer
            ),
          });
        }
      }
    });
  });

export const until = <A>(read: () => A, done: (value: A) => boolean) =>
  Effect.sync(read).pipe(eventually(done));

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
              closing
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
) => ActionRpc.client(binding).pipe(Effect.provideContext(socket.protocol));

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
    eventually(
      (held) =>
        held.length === sockets &&
        held.every(
          ({ calls, parked }) => calls.length === 0 && parked.length === 1
        ),
      "20 seconds"
    )
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

export const invokedSince = (finished: number) =>
  stubs.pipe(eventually((counts) => counts.finished.invoke > finished));

export const settledStubs = stubs.pipe(
  Effect.repeat({
    until: ({ started, finished }) =>
      started.invoke === finished.invoke &&
      started.hold === finished.hold &&
      started.acknowledge === finished.acknowledge,
    schedule: Schedule.spaced("100 millis"),
  })
);
