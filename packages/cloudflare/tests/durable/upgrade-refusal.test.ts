import { env } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { expectedProtocol, VersionedRpcs } from "../support/versioned.js";

let objects = 0;

const fresh = () => env.VERSIONED.getByName(`versioned-${objects++}`);

const upgrade = (stub: DurableObjectStub, protocol: string) =>
  Effect.promise(async () => {
    const response = await stub.fetch(`https://object/rpc?protocol=${protocol}`, {
      headers: { upgrade: "websocket" },
    });

    const socket = response.webSocket;

    if (socket === null) throw new Error(`No WebSocket: ${response.status}`);

    return { status: response.status, socket };
  });

const acceptedAsTheClientListens = (socket: WebSocket) =>
  Effect.flatMap(
    Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(
          Layer.effect(Socket.Socket)(
            Socket.fromWebSocket(
              Effect.sync(() => {
                socket.accept();

                return socket;
              }),
            ),
          ),
        ),
        Layer.provide(RpcSerialization.layerJson),
      ),
    ),
    (protocol) => RpcClient.make(VersionedRpcs).pipe(Effect.provideContext(protocol)),
  );

describe("router middleware around layerWebSocket's route", () => {
  it.effect(
    "refuses an upgrade by answering 101 and closing the socket with a code and reason, which Effect's socket client sees",
    () =>
      Effect.gen(function* () {
        const { status, socket } = yield* upgrade(fresh(), "2");
        const client = yield* acceptedAsTheClientListens(socket);
        const refused = yield* Effect.flip(client.protocol());

        expect(status).toBe(101);
        expect(refused.reason).toMatchObject({
          _tag: "SocketCloseError",
          code: 4000,
          closeReason: "unsupported protocol",
        });
      }).pipe(Effect.scoped),
  );

  it.effect("passes an upgrade it accepts on to the library's route, which serves it", () =>
    Effect.gen(function* () {
      const { status, socket } = yield* upgrade(fresh(), expectedProtocol);
      const client = yield* acceptedAsTheClientListens(socket);

      expect(status).toBe(101);
      expect(yield* client.protocol()).toBe(expectedProtocol);
    }).pipe(Effect.scoped),
  );
});
