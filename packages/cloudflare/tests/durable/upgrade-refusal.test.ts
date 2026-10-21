import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { allowedOrigin, expectedProtocol, statusKey, VersionedRpcs } from "../support/versioned.js";

let objects = 0;

const fresh = () => env.VERSIONED.getByName(`versioned-${objects++}`);

const upgrade = (stub: DurableObjectStub, query: string, origin = allowedOrigin) =>
  Effect.promise(async () => {
    const response = await stub.fetch(`https://object/rpc${query}`, {
      headers: { upgrade: "websocket", origin },
    });

    const socket = response.webSocket;

    if (socket === null) throw new Error(`No WebSocket: ${response.status}`);

    const logged = await runInDurableObject(stub, (_, state) => state.storage.get(statusKey));

    return { status: response.status, logged, socket };
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

describe("layerWebSocket's protocol", () => {
  it.effect(
    "refuses an upgrade naming another version, or none, with refuseUpgrade, 101 to Effect's server as to the page, its code and a reason naming the version for Effect's socket client",
    () =>
      Effect.gen(function* () {
        for (const query of ["?protocol=2", "", "?version=3"]) {
          const { status, logged, socket } = yield* upgrade(fresh(), query);
          const client = yield* acceptedAsTheClientListens(socket);
          const refused = yield* Effect.flip(client.protocol());

          expect([status, logged]).toEqual([101, 101]);
          expect(refused.reason).toMatchObject({
            _tag: "SocketCloseError",
            code: 4000,
            closeReason: "This server speaks protocol 3: reload the page",
          });
        }
      }).pipe(Effect.scoped),
  );

  it.effect("serves an upgrade naming its version, 101 to Effect's server as to the page", () =>
    Effect.gen(function* () {
      const { status, logged, socket } = yield* upgrade(fresh(), `?protocol=${expectedProtocol}`);
      const client = yield* acceptedAsTheClientListens(socket);

      expect([status, logged]).toEqual([101, 101]);
      expect(yield* client.protocol()).toBe(expectedProtocol);
    }).pipe(Effect.scoped),
  );
});

describe("router middleware around layerWebSocket's route", () => {
  it.effect(
    "refuses an upgrade by any other judge, such as a foreign Origin, with refuseUpgrade, before the protocol is read",
    () =>
      Effect.gen(function* () {
        const { status, logged, socket } = yield* upgrade(
          fresh(),
          `?protocol=${expectedProtocol}`,
          "https://elsewhere.example",
        );

        const client = yield* acceptedAsTheClientListens(socket);
        const refused = yield* Effect.flip(client.protocol());

        expect([status, logged]).toEqual([101, 101]);
        expect(refused.reason).toMatchObject({
          _tag: "SocketCloseError",
          code: 4003,
          closeReason: "foreign origin",
        });
      }).pipe(Effect.scoped),
  );
});
