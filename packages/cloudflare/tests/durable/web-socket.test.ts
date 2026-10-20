import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { Cause, Effect, Exit, Layer, Predicate, Schedule } from "effect";
import { HttpRouter } from "effect/http";
import { RpcClient } from "effect/rpc";
import { describe, expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";
import { noteHeader, Overdrawn } from "../support/app.js";
import type { Room } from "../worker.js";
import { scopedClientOver, upgradeToRpc } from "../support/socket.js";

const room = (name: string) => env.ROOM.getByName(name);

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("layerWebSocket", () => {
  it.effect("serves rpcs on a socket, as the upgrade request's token, with declared errors", () =>
    Effect.gen(function* () {
      const client = yield* scopedClientOver(yield* upgradeToRpc(room("serves"), bearer("ada")));

      expect(yield* client.whoami()).toBe("ada");
      expect(yield* client.spend({ amount: 4 })).toEqual({ left: 6 });
      expect(yield* Effect.flip(client.spend({ amount: 7 }))).toEqual(new Overdrawn({ by: 1 }));
    }).pipe(Effect.scoped),
  );

  it.effect("authenticates each message with its own token over the saved one", () =>
    Effect.gen(function* () {
      const client = yield* scopedClientOver(yield* upgradeToRpc(room("own-token"), bearer("ada")));

      expect(yield* client.whoami().pipe(RpcClient.withHeaders(bearer("grace")))).toBe("grace");
      expect(yield* client.whoami()).toBe("ada");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "authenticates each message of a native rpc with its own token over the saved one",
    () =>
      Effect.gen(function* () {
        const client = yield* scopedClientOver(
          yield* upgradeToRpc(room("own-native"), bearer("ada")),
        );

        expect(yield* client.whose().pipe(RpcClient.withHeaders(bearer("grace")))).toBe("grace");
        expect(yield* client.whose()).toBe("ada");
      }).pipe(Effect.scoped),
  );

  it.effect("refuses a socket's protected calls without a token, and serves its public ones", () =>
    Effect.gen(function* () {
      const client = yield* scopedClientOver(yield* upgradeToRpc(room("anonymous")));

      expect(yield* Effect.flip(client.whoami())).toBeInstanceOf(Action.Unauthenticated);
      expect(yield* client.readNote()).toBe("none");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps the upgrade request's headers, its token included, across hibernation, on a new instance",
    () =>
      Effect.gen(function* () {
        const stub = room("hibernates");
        const socket = yield* upgradeToRpc(stub, { ...bearer("grace"), [noteHeader]: "kept" });
        const client = yield* scopedClientOver(socket);

        expect(yield* client.spend({ amount: 3 })).toEqual({ left: 7 });

        yield* Effect.promise(() => evictDurableObject(stub));

        expect(yield* client.whoami()).toBe("grace");
        expect(yield* client.readNote()).toBe("kept");
        expect(yield* client.spend({ amount: 3 })).toEqual({ left: 7 });
      }).pipe(Effect.scoped),
  );

  const replaceAttachment = (
    stub: DurableObjectStub,
    attachment: { readonly headers: string } | undefined,
  ) =>
    Effect.promise(() =>
      runInDurableObject(stub, (_, state) => {
        const [held] = state.getWebSockets();

        if (held === undefined) throw new Error("No socket");

        held.serializeAttachment(attachment);

        return Predicate.isNullish(held.deserializeAttachment());
      }),
    );

  it.effect(
    "serves a socket whose attachment the runtime dropped, with each message's own headers",
    () =>
      Effect.gen(function* () {
        const stub = room("dropped-attachment");
        const client = yield* scopedClientOver(yield* upgradeToRpc(stub, bearer("ada")));

        expect(yield* client.whoami()).toBe("ada");
        expect(yield* replaceAttachment(stub, undefined)).toBe(true);
        expect(yield* client.whoami().pipe(RpcClient.withHeaders(bearer("grace")))).toBe("grace");
        expect(yield* Effect.flip(client.whoami())).toBeInstanceOf(Action.Unauthenticated);
      }).pipe(Effect.scoped),
  );

  it.effect("answers a message on a socket whose attachment does not decode with a defect", () =>
    Effect.gen(function* () {
      const stub = room("unreadable-attachment");
      const socket = yield* upgradeToRpc(stub, bearer("ada"));
      const client = yield* scopedClientOver(socket);

      expect(yield* replaceAttachment(stub, { headers: "not pairs" })).toBe(false);

      const exit = yield* Effect.exit(client.whoami().pipe(RpcClient.withHeaders(bearer("ada"))));

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      expect(socket.readyState).toBe(WebSocket.OPEN);
    }).pipe(Effect.scoped),
  );

  it.effect("answers a client's ping without waking the object", () =>
    Effect.gen(function* () {
      const stub = room("pings");
      const socket = yield* upgradeToRpc(stub);

      const pong = yield* Effect.promise(
        () =>
          new Promise<string>((resolve) => {
            socket.addEventListener("message", ({ data }) => resolve(String(data)), { once: true });
            socket.send(JSON.stringify({ _tag: "Ping" }));
          }),
      );

      expect(JSON.parse(pong)).toEqual({ _tag: "Pong" });

      const answered = yield* Effect.promise(() =>
        runInDurableObject(stub, (_, state) =>
          state.getWebSockets().map((held) => state.getWebSocketAutoResponseTimestamp(held)),
        ),
      );

      expect(answered).toEqual([expect.any(Date)]);
    }),
  );

  it.effect("ends a message's event before its call ends, and answers the call after", () =>
    Effect.gen(function* () {
      const stub = room("outlives");
      const socket = yield* upgradeToRpc(stub);

      const reply = new Promise<unknown>((resolve) =>
        socket.addEventListener("message", ({ data }) => resolve(JSON.parse(String(data))), {
          once: true,
        }),
      );

      const lasted = yield* Effect.promise(() =>
        runInDurableObject(stub, async (instance: Room, state) => {
          const [held] = state.getWebSockets();

          if (held === undefined) throw new Error("No socket");

          const started = Date.now();

          await instance.webSocketMessage(
            held,
            JSON.stringify({ _tag: "Request", id: 1, tag: "pause", payload: {}, headers: [] }),
          );

          return Date.now() - started;
        }),
      );

      expect(lasted).toBeLessThan(100);
      expect(yield* Effect.promise(() => reply)).toMatchObject({
        _tag: "Exit",
        requestId: 1,
        exit: { _tag: "Success" },
      });
    }),
  );

  it.live("interrupts a socket's running call when the socket closes", () =>
    Effect.gen(function* () {
      const stub = room("closes");
      const socket = yield* upgradeToRpc(stub);

      const stored = (key: string) =>
        Effect.promise(() => runInDurableObject(stub, (_, state) => state.storage.get(key))).pipe(
          Effect.repeat({
            until: (value) => value === true,
            schedule: Schedule.spaced("5 millis"),
          }),
          Effect.timeout("1 second"),
        );

      socket.send(
        JSON.stringify({ _tag: "Request", id: 1, tag: "pause", payload: {}, headers: [] }),
      );

      yield* stored("pauseStarted");

      socket.close(1000);

      expect(yield* stored("pauseInterrupted")).toBe(true);
    }),
  );

  it.effect(
    "answers a client's close with its own code and reason, without the runtime's reply",
    () =>
      Effect.gen(function* () {
        const socket = yield* upgradeToRpc(room("answers-close"), bearer("ada"));

        const closed = Effect.promise(
          () =>
            new Promise<CloseEvent>((resolve) =>
              socket.addEventListener("close", resolve, { once: true }),
            ),
        );

        socket.close(4000, "page left");

        const { code, reason, wasClean } = yield* closed.pipe(Effect.timeout("2 seconds"));

        expect({ code, reason, wasClean }).toEqual({
          code: 4000,
          reason: "page left",
          wasClean: true,
        });
      }),
  );

  it.effect("ignores a close event for a socket already answered", () =>
    Effect.gen(function* () {
      const stub = room("closed-twice");

      yield* upgradeToRpc(stub, bearer("ada"));

      yield* Effect.promise(() =>
        runInDurableObject(stub, async (instance, state) => {
          const [socket] = state.getWebSockets();

          if (socket === undefined) throw new Error("No socket");

          await instance.webSocketClose(socket, 1000, "", true);
          await instance.webSocketClose(socket, 1000, "", true);
        }),
      );
    }),
  );

  it.effect("answers a frame it cannot read with a defect, and serves the socket after it", () =>
    Effect.gen(function* () {
      const socket = yield* upgradeToRpc(room("answers-unreadable"), bearer("ada"));

      const received = yield* Effect.promise(
        () =>
          new Promise<ReadonlyArray<unknown>>((resolve) => {
            const messages: Array<unknown> = [];

            socket.addEventListener("message", ({ data }) =>
              messages.push(JSON.parse(String(data))),
            );
            socket.send("{");
            socket.send("null");
            socket.send(
              JSON.stringify({ _tag: "Request", id: 5, tag: "whoami", payload: {}, headers: null }),
            );
            setTimeout(resolve, 100, messages);
          }),
      );

      expect(received).toEqual([
        expect.objectContaining({ _tag: "Defect" }),
        expect.objectContaining({ _tag: "Defect" }),
        expect.objectContaining({ _tag: "Defect" }),
      ]);
      expect(yield* (yield* scopedClientOver(socket)).whoami()).toBe("ada");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to register with a Sockets that Sockets.layer did not build", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.promise(() =>
        runInDurableObject(env.PLAIN.getByName("foreign-sockets"), (_, state) =>
          Effect.runPromiseExit(
            Layer.build(
              ActionDurableObject.layerWebSocket({ path: "/rpc" }).pipe(
                Layer.provide([
                  Layer.succeed(ActionDurableObject.State, state),
                  Layer.succeed(ActionDurableObject.Sockets, {
                    message: () => Effect.succeed(false),
                    close: () => Effect.succeed(false),
                    error: () => Effect.succeed(false),
                  }),
                  ActionDurableObject.Feed.layer.pipe(
                    Layer.provide(Layer.succeed(ActionDurableObject.State, state)),
                  ),
                  HttpRouter.layer,
                ]),
              ),
            ).pipe(Effect.scoped),
          ),
        ),
      );

      expect(String(Exit.isFailure(exit) && Cause.squash(exit.cause))).toContain(
        "registers only with a Sockets that Sockets.layer built",
      );
    }),
  );

  it.effect("refuses to build two protocols at one path under different prefixes", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Effect.tryPromise(() => env.PREFIXED.getByName("prefixed").fetch("https://object/a/rpc")),
      );

      expect(String(failure.cause)).toContain("a router prefix does not tell them apart");
    }),
  );

  it.effect("refuses an upgrade whose headers exceed a socket's attachment with 431", () =>
    Effect.gen(function* () {
      const stub = room("too-large");

      const response = yield* Effect.promise(() =>
        stub.fetch("https://object/rpc", {
          headers: { upgrade: "websocket", authorization: `Bearer ${"x".repeat(20_000)}` },
        }),
      );

      const held = yield* Effect.promise(() =>
        runInDurableObject(stub, (_, state) => state.getWebSockets().length),
      );

      expect([response.status, held]).toEqual([431, 0]);
    }),
  );

  it.effect("never gives a socket's calls a service only router middleware provides", () =>
    Effect.gen(function* () {
      const socket = yield* upgradeToRpc(env.ROUTER_PROVIDED.getByName("router-provided"));
      const client = yield* scopedClientOver(socket);
      const exit = yield* Effect.exit(client.readNote());

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      expect(String(Exit.isFailure(exit) && Cause.squash(exit.cause))).toContain(
        "Internal server error",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("answers a request to the route that is no upgrade with 426", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() => room("plain-get").fetch("https://object/rpc"));

      expect(response.status).toBe(426);
    }),
  );
});
