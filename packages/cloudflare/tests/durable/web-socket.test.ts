import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { Cause, Effect, Exit, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http";
import { RpcClient } from "effect/rpc";
import { describe, expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";
import { Http, noteHeader, Overdrawn, Rpc, slowCleanupNote } from "../support/app.js";
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

  it.effect("refuses a socket's protected calls without a token, and serves its public ones", () =>
    Effect.gen(function* () {
      const client = yield* scopedClientOver(yield* upgradeToRpc(room("anonymous")));

      expect(yield* Effect.flip(client.whoami())).toBeInstanceOf(Action.Unauthenticated);
      expect(yield* client.readNote()).toBe("none");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps the credential and the listed headers across hibernation, on a new instance",
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

  const request = (id: string | number, tag: string) =>
    JSON.stringify({ _tag: "Request", id, tag, payload: {}, headers: [] });

  const withHeldSocket = <A>(name: string, use: (instance: Room, held: WebSocket) => Promise<A>) =>
    Effect.gen(function* () {
      const stub = room(name);

      yield* upgradeToRpc(stub);

      return yield* Effect.promise(() =>
        runInDurableObject(stub, (instance: Room, state) => {
          const [held] = state.getWebSockets();

          if (held === undefined) throw new Error("No socket");

          return use(instance, held);
        }),
      );
    });

  const settledWithin = (event: Promise<void>, millis: number) =>
    Promise.race([
      event.then(() => "settled"),
      new Promise((resolve) => setTimeout(resolve, millis, "pending")),
    ]);

  const heldEvents = [
    {
      title: "holds a message's event open until each of its requests has its exit",
      name: "holds",
      between: [],
    },
    {
      title: "holds it open through another request whose id is the same as a string",
      name: "holds-string-id",
      between: [request("1", "readNote")],
    },
    {
      title: "holds it open through a request reusing its id, which it drops",
      name: "holds-reused-id",
      between: [request(1, "hold")],
    },
    {
      title: "holds it open through a frame the server answers with a defect",
      name: "holds-defect",
      between: [JSON.stringify({ _tag: "Bogus" })],
    },
    {
      title: "holds it open through a request whose id is neither a string nor a number",
      name: "holds-null-id",
      between: [
        JSON.stringify({ _tag: "Request", id: null, tag: "readNote", payload: {}, headers: [] }),
      ],
    },
    {
      title: "holds a frame's event open past an earlier request of it under the same id",
      name: "holds-batch",
      between: [],
      holdingFrame: `[${request(1, "readNote")},${request(1, "hold")}]`,
    },
    {
      title: "holds it open through a request reusing its id that names no action",
      name: "holds-reused-unknown",
      between: [request(1, "notAnAction")],
    },
    {
      title: "holds it open through a request reusing its id without a payload",
      name: "holds-reused-no-payload",
      between: [JSON.stringify({ _tag: "Request", id: 1, tag: "hold", headers: [] })],
    },
    {
      title: "answers a frame of null without rejecting its event",
      name: "holds-null-frame",
      between: ["null"],
    },
    {
      title: "holds a frame's event open past a later item that is null",
      name: "holds-null-item",
      between: [],
      holdingFrame: `[${request(1, "hold")},null]`,
    },
    {
      title: "holds a frame's event open past a later request without headers",
      name: "holds-headerless-item",
      between: [],
      holdingFrame: `[${request(1, "hold")},${JSON.stringify({ _tag: "Request", id: 3, tag: "readNote", payload: {}, headers: null })}]`,
    },
  ];

  for (const { title, name, between, holdingFrame = request(1, "hold") } of heldEvents) {
    it.effect(title, () =>
      Effect.gen(function* () {
        const early = yield* withHeldSocket(name, async (instance, held) => {
          const holding = instance.webSocketMessage(held, holdingFrame);

          await Promise.all(between.map((message) => instance.webSocketMessage(held, message)));

          const early = await settledWithin(holding, 50);

          await instance.webSocketMessage(held, request(2, "release"));
          await holding;

          return early;
        });

        expect(early).toBe("pending");
      }),
    );
  }

  it.effect("holds a message's event open until its middleware's finalizers have run", () =>
    Effect.gen(function* () {
      const settled = yield* withHeldSocket("holds-cleanup", async (instance, held) => {
        const event = instance.webSocketMessage(
          held,
          JSON.stringify({
            _tag: "Request",
            id: 1,
            tag: "readNote",
            payload: {},
            headers: [[noteHeader, slowCleanupNote]],
          }),
        );

        const early = await settledWithin(event, 50);

        await event;

        return early;
      });

      expect(settled).toBe("pending");
    }),
  );

  it.effect("answers a message it cannot read with a defect, and keeps no record of it", () =>
    Effect.gen(function* () {
      const socket = yield* upgradeToRpc(room("answers-unreadable"));

      const received = yield* Effect.promise(
        () =>
          new Promise<ReadonlyArray<unknown>>((resolve) => {
            const messages: Array<unknown> = [];

            socket.addEventListener("message", ({ data }) =>
              messages.push(JSON.parse(String(data))),
            );
            socket.send("null");
            socket.send(
              JSON.stringify({
                _tag: "Request",
                id: 5,
                tag: "readNote",
                payload: {},
                headers: [null],
              }),
            );
            socket.send(JSON.stringify({ _tag: "Interrupt", requestId: 5 }));
            setTimeout(resolve, 100, messages);
          }),
      );

      expect(received).toEqual([
        expect.objectContaining({ _tag: "Defect" }),
        expect.objectContaining({ _tag: "Defect" }),
      ]);
    }),
  );

  it.effect("ends a held event when its socket closes", () =>
    Effect.gen(function* () {
      const settled = yield* withHeldSocket("closes-held", async (instance, held) => {
        const holding = instance.webSocketMessage(held, request(1, "hold"));

        await instance.webSocketClose(held);

        return settledWithin(holding, 200);
      });

      expect(settled).toBe("settled");
    }),
  );

  it.effect("refuses an event on a socket no protocol of the routes accepted", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Effect.tryPromise(() =>
          runInDurableObject(room("foreign"), async (instance: Room, state) => {
            const { 1: server } = new WebSocketPair();

            state.acceptWebSocket(server, ["foreign"]);

            await instance.webSocketMessage(server, "{}");
          }),
        ),
      );

      expect(String(failure.cause)).toContain(
        "No ActionDurableObject.layerWebSocket of these routes accepted this socket",
      );
    }),
  );

  it.effect("refuses to build outside a class make returns", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.promise(() =>
        runInDurableObject(env.PLAIN.getByName("outside-make"), (_, state) =>
          Effect.runPromiseExit(
            Layer.build(
              ActionDurableObject.layerWebSocket(Rpc, { path: "/rpc" }).pipe(
                Layer.provide([Layer.succeed(ActionDurableObject.State, state), HttpRouter.layer]),
              ),
            ).pipe(Effect.scoped),
          ),
        ),
      );

      expect(String(Exit.isFailure(exit) && Cause.squash(exit.cause))).toContain(
        "serves only the routes of a class ActionDurableObject.make returns",
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

  it.effect("refuses an upgrade whose kept headers exceed a socket's attachment with 431", () =>
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

describe("make", () => {
  it.effect("serves the routes' JSON over fetch, built with the object's State", () =>
    Effect.gen(function* () {
      const client = yield* ActionHttp.client(Http, {
        baseUrl: "https://object",
        transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken("ada")),
      });

      expect(yield* client.whoami()).toBe("ada");
      expect(yield* client.alarms()).toBe(0);
    }).pipe(Effect.provide(ActionDurableObject.layerHttpClient(room("fetch")))),
  );

  it.effect("fails every request with the routes' build failure", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Effect.tryPromise(() => env.BROKEN.getByName("broken").fetch("https://object/")),
      );

      expect(String(failure.cause)).toContain("Unreachable");
    }),
  );

  it.effect("rejects an alarm when make was given none", () =>
    Effect.gen(function* () {
      const rejected = yield* Effect.flip(
        Effect.tryPromise(() =>
          runInDurableObject(env.ROUTER_PROVIDED.getByName("no-alarm"), (instance) =>
            instance.alarm(),
          ),
        ),
      );

      expect(String(rejected.cause)).toContain("ActionDurableObject.make was given no alarm");
    }),
  );

  it.effect(
    "runs the alarm on a woken instance once the routes are built, sharing their build",
    () =>
      Effect.gen(function* () {
        const stub = room("alarm");

        const client = yield* ActionHttp.client(Http, {
          baseUrl: "https://object",
          transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken("ada")),
        });

        yield* client.schedule();
        yield* Effect.promise(() => evictDurableObject(stub));

        expect(yield* Effect.promise(() => runDurableObjectAlarm(stub))).toBe(true);
        expect(yield* client.alarms()).toBe(1);
        expect(yield* client.spend({ amount: 9 })).toEqual({ left: 0 });
      }).pipe(Effect.provide(ActionDurableObject.layerHttpClient(room("alarm")))),
  );
});
