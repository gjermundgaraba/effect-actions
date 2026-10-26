import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";
import { Sockets } from "../../src/durable/sockets.js";
import {
  allowedOrigin,
  expectedProtocol,
  givenReason,
  longestVersion,
  statusKey,
  VersionedRpcs,
} from "../support/versioned.js";

let objects = 0;

const fresh = () => env.VERSIONED.getByName(`versioned-${objects++}`);

const upgrade = (
  stub: DurableObjectStub,
  target: string,
  headers: Record<string, string> = { origin: allowedOrigin },
) =>
  Effect.promise(async () => {
    const response = await stub.fetch(`https://object${target}`, {
      headers: { upgrade: "websocket", ...headers },
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

const built = (protocol: NonNullable<ActionDurableObject.LayerWebSocketOptions["protocol"]>) =>
  Effect.promise(() =>
    runInDurableObject(env.PLAIN.getByName(`built-${objects++}`), (_, state) =>
      Effect.runPromiseExit(
        Layer.build(
          ActionDurableObject.layerWebSocket({ path: "/rpc", protocol }).pipe(
            Layer.provide([Sockets.layer, HttpRouter.layer]),
            Layer.provide(Layer.succeed(ActionDurableObject.State, state)),
          ),
        ).pipe(Effect.scoped),
      ),
    ),
  ).pipe(Effect.map((exit) => (Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "built")));

describe("layerWebSocket's protocol", () => {
  it.effect(
    "fails the build with a code other than 4000 to 4999, naming the field and the codes it accepts",
    () =>
      Effect.gen(function* () {
        expect(yield* built({ version: "3", code: 2000 })).toBe(
          "Error: ActionDurableObject.layerWebSocket's protocol.code 2000 is not one it accepts, an integer from 4000 to 4999, the codes a watch ends at: give one of those",
        );

        for (const code of [999, 1000, 1001, 1006, 2999, 3000, 3999, 5000, 4000.5]) {
          expect(yield* built({ version: "3", code })).toContain(
            "is not one it accepts, an integer from 4000 to 4999",
          );
        }

        for (const code of [4000, 4500, 4999]) {
          expect(yield* built({ version: "3", code })).toBe("built");
        }
      }),
  );

  it.effect(
    "fails the build with a reason past a close frame's 123 bytes, UTF-8 encoded, the default naming a long version too",
    () =>
      Effect.gen(function* () {
        expect(yield* built({ version: "3", code: 4000, reason: "é".repeat(62) })).toContain(
          "protocol.reason, given or the default naming its version, is 124 bytes, more than the 123 a close frame holds",
        );
        expect(yield* built({ version: "3", code: 4000, reason: `x${"é".repeat(61)}` })).toBe(
          "built",
        );
        expect(yield* built({ version: `${longestVersion}x`, code: 4000 })).toContain(
          "the default naming its version, is 124 bytes",
        );
        expect(yield* built({ version: longestVersion, code: 4000 })).toBe("built");
        expect(
          yield* built({ version: "v".repeat(128), code: 4000, reason: "Reload the page" }),
        ).toBe("built");
      }),
  );

  it.effect(
    "refuses a page of another version, naming the longest version that fits in the default reason, UTF-8 encoded",
    () =>
      Effect.gen(function* () {
        const { status, socket } = yield* upgrade(fresh(), "/longest?protocol=2");
        const client = yield* acceptedAsTheClientListens(socket);
        const { reason } = yield* Effect.flip(client.protocol());

        expect(status).toBe(101);
        expect(reason).toMatchObject({
          _tag: "SocketCloseError",
          code: 4000,
          closeReason: `This server speaks protocol ${longestVersion}: reload the page`,
        });
      }).pipe(Effect.scoped),
  );

  it.effect(
    "refuses an upgrade naming another version, or none, with refuseUpgrade, 101 to Effect's server as to the page, its code and a reason naming the version for Effect's socket client",
    () =>
      Effect.gen(function* () {
        for (const query of ["?protocol=2", "", "?version=3"]) {
          const { status, logged, socket } = yield* upgrade(fresh(), `/rpc${query}`);
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
      const { status, logged, socket } = yield* upgrade(
        fresh(),
        `/rpc?protocol=${expectedProtocol}`,
      );

      const client = yield* acceptedAsTheClientListens(socket);

      expect([status, logged]).toEqual([101, 101]);
      expect(yield* client.protocol()).toBe(expectedProtocol);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses with the reason given, which reaches the page's client", () =>
    Effect.gen(function* () {
      const { socket } = yield* upgrade(fresh(), "/reasoned?protocol=2");
      const client = yield* acceptedAsTheClientListens(socket);
      const refused = yield* Effect.flip(client.protocol());

      expect(refused.reason).toMatchObject({
        _tag: "SocketCloseError",
        code: 4001,
        closeReason: givenReason,
      });
    }).pipe(Effect.scoped),
  );

  it.effect(
    "refuses a page of another version before judging its headers, and answers 431 to one of its version whose headers exceed a socket's attachment",
    () =>
      Effect.gen(function* () {
        const oversized = { origin: allowedOrigin, authorization: `Bearer ${"x".repeat(20_000)}` };
        const { socket } = yield* upgrade(fresh(), "/rpc?protocol=2", oversized);
        const client = yield* acceptedAsTheClientListens(socket);

        const served = yield* Effect.promise(() =>
          fresh().fetch(`https://object/rpc?protocol=${expectedProtocol}`, {
            headers: { upgrade: "websocket", ...oversized },
          }),
        );

        expect((yield* Effect.flip(client.protocol())).reason).toMatchObject({ code: 4000 });
        expect(served.status).toBe(431);
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
          `/rpc?protocol=${expectedProtocol}`,
          { origin: "https://elsewhere.example" },
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
