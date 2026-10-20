import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { Cause, Effect, Exit } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { describe, expect, it } from "@effect/vitest";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";
import { alarmBuildsKey, Builds, Http, ownTag, readyKey } from "../support/app.js";
import type { OwnSockets, Room } from "../worker.js";
import { nextMessage, scopedClientOver, upgradeTo, upgradeToRpc } from "../support/socket.js";

const room = (name: string) => env.ROOM.getByName(name);

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const textOf = (response: Response) => Effect.promise(() => response.text());

const setAlarm = (stub: DurableObjectStub) =>
  Effect.promise(() =>
    runInDurableObject(stub, (_, state) => state.storage.setAlarm(Date.now() + 60_000)),
  );

const stored = (stub: DurableObjectStub, key: string) =>
  Effect.promise(() => runInDurableObject(stub, (_, state) => state.storage.get(key)));

describe("handlers", () => {
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

  it.effect("gives each request a service the routes provide themselves", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        room("greeting").fetch("https://object/greeting"),
      );

      expect(yield* textOf(response)).toBe("hello");
    }),
  );

  it.effect("fails every request with the routes' build failure", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Effect.tryPromise(() => env.BROKEN.getByName("broken").fetch("https://object/")),
      );

      expect(String(failure.cause)).toContain("Unreachable");
    }),
  );

  it.effect("builds the services once for the routes, a stub method's run and the alarm", () =>
    Effect.gen(function* () {
      const stub = env.COUNTED.getByName("fetched-first");
      const response = yield* Effect.promise(() => stub.fetch("https://object/builds"));

      expect(yield* textOf(response)).toBe("1");
      expect(yield* Effect.promise(() => stub.builds())).toBe(1);

      yield* setAlarm(stub);

      expect(yield* Effect.promise(() => runDurableObjectAlarm(stub))).toBe(true);
      expect(yield* stored(stub, alarmBuildsKey)).toBe(1);
      expect(yield* Effect.promise(() => stub.builds())).toBe(1);
    }),
  );

  it.effect("builds once for two first events arriving while it builds", () =>
    Effect.gen(function* () {
      const stub = env.COUNTED.getByName("concurrent");

      const [response, builds] = yield* Effect.promise(() =>
        Promise.all([stub.fetch("https://object/builds"), stub.builds()]),
      );

      expect([yield* textOf(response), builds]).toEqual(["1", 1]);
    }),
  );

  it.effect("runs a stub method on an instance never fetched once the services are built", () =>
    Effect.gen(function* () {
      const stub = env.COUNTED.getByName("called-first");

      expect(yield* Effect.promise(() => stub.builds())).toBe(1);

      const response = yield* Effect.promise(() => stub.fetch("https://object/builds"));

      expect(yield* textOf(response)).toBe("1");
    }),
  );

  it.effect("builds a Layer a run provides itself for that run alone", () =>
    Effect.gen(function* () {
      const stub = env.COUNTED.getByName("provided");

      expect(yield* Effect.promise(() => stub.builds())).toBe(1);
      expect(yield* Effect.promise(() => stub.providedBuilds())).toBe(2);
      expect(yield* Effect.promise(() => stub.providedBuilds())).toBe(3);
      expect(yield* Effect.promise(() => stub.builds())).toBe(1);
    }),
  );

  it.effect("fails fetch and run with the services' build failure", () =>
    Effect.gen(function* () {
      const stub = env.BROKEN_SERVICES.getByName("broken-services");

      const failures = yield* Effect.all([
        Effect.flip(Effect.tryPromise(() => stub.fetch("https://object/"))),
        Effect.flip(
          Effect.tryPromise(() =>
            runInDurableObject(stub, (instance) => instance.run(Effect.void)),
          ),
        ),
      ]);

      for (const failure of failures) expect(String(failure.cause)).toContain("Unreachable");
    }),
  );

  it.effect("rejects run with the routes' build failure", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Effect.tryPromise(() =>
          runInDurableObject(env.BROKEN.getByName("broken-run"), (instance) =>
            instance.run(Effect.void),
          ),
        ),
      );

      expect(String(failure.cause)).toContain("Unreachable");
    }),
  );

  it.effect("builds everything again from nothing on the event after a failed build", () =>
    Effect.gen(function* () {
      const stub = env.RETRIED.getByName("retried");

      const failure = yield* Effect.flip(
        Effect.tryPromise(() => stub.fetch("https://object/builds")),
      );

      expect(String(failure.cause)).toContain("NotReady");

      yield* Effect.promise(() =>
        runInDurableObject(stub, (_, state) => state.storage.put(readyKey, true)),
      );

      const client = yield* scopedClientOver(yield* upgradeToRpc(stub, bearer("ada")));

      expect(yield* client.whoami()).toBe("ada");

      const response = yield* Effect.promise(() => stub.fetch("https://object/builds"));

      expect(yield* textOf(response)).toBe("2");
    }).pipe(Effect.scoped),
  );

  it.effect("builds again on the event after a build that failed before it awaited anything", () =>
    Effect.gen(function* () {
      const stub = env.RETRIED_AT_ONCE.getByName("retried-at-once");

      const failure = yield* Effect.flip(
        Effect.tryPromise(() => stub.fetch("https://object/ready")),
      );

      expect(String(failure.cause)).toContain("NotReady");

      yield* Effect.promise(() =>
        runInDurableObject(stub, (_, state) => state.storage.kv.put(readyKey, true)),
      );

      const response = yield* Effect.promise(() => stub.fetch("https://object/ready"));

      expect(yield* textOf(response)).toBe("ready");
    }),
  );

  it.effect(
    "runs the alarm on a woken instance once the routes are built, sharing their services",
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

  it.effect("serves a class of its own without routes, answering fetch with 404", () =>
    Effect.gen(function* () {
      const stub = env.HOSTED.getByName("hosted");
      const response = yield* Effect.promise(() => stub.fetch("https://object/builds"));

      expect(response.status).toBe(404);
      expect(yield* Effect.promise(() => stub.builds())).toBe(1);

      yield* setAlarm(stub);

      expect(yield* Effect.promise(() => runDurableObjectAlarm(stub))).toBe(true);
      expect(yield* stored(stub, alarmBuildsKey)).toBe(1);
    }),
  );

  it.effect("resolves every socket handler's event on a socket no protocol accepted", () =>
    Effect.gen(function* () {
      const stub = env.OWN_SOCKETS.getByName("own-closes");

      yield* upgradeTo(stub, "https://object/own");

      yield* Effect.promise(() =>
        runInDurableObject(stub, async (instance: OwnSockets, state) => {
          const [held] = state.getWebSockets(ownTag);

          if (held === undefined) throw new Error("No socket");

          await instance.webSocketError(held, new Error("lost"));
          await instance.webSocketClose(held, 1000, "", true);
        }),
      );

      yield* Effect.promise(() =>
        runInDurableObject(room("foreign"), async (instance: Room, state) => {
          const { 1: server } = new WebSocketPair();

          state.acceptWebSocket(server, ["foreign"]);

          await instance.webSocketMessage(server, "{}");
        }),
      );
    }),
  );
  it.effect("answers socket events without routes and calls without calls, building nothing", () =>
    Effect.gen(function* () {
      const { refused, builds } = yield* Effect.promise(() =>
        runInDurableObject(env.HOSTED.getByName("nothing-served"), async (_, state) => {
          const object = ActionDurableObject.handlers(state, { services: Builds.layer });
          const { 1: server } = new WebSocketPair();

          state.acceptWebSocket(server);

          await object.webSocketMessage(server, "{}");
          await object.webSocketClose(server, 1000, "", true);
          await object.webSocketError(server, new Error("lost"));

          return {
            refused: await object.effectActionsRpc("[]").then(() => "answered", String),
            builds: await state.storage.get("builds"),
          };
        }),
      );

      expect(refused).toContain("serves no rpcs over its stub");
      expect(builds).toBeUndefined();
    }),
  );
  it.effect("dies on a call through a Calls no protocol registered with", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        ActionDurableObject.Calls.use((calls) => calls.call("[]")).pipe(
          Effect.provide(ActionDurableObject.Calls.layer),
        ),
      );

      expect(String(Exit.isFailure(exit) && Cause.squash(exit.cause))).toContain(
        "No ActionDurableObject.layerStub protocol registered",
      );
    }),
  );
});

describe("make", () => {
  it.effect("defines no alarm handler when make was given none", () =>
    Effect.gen(function* () {
      const handlers = yield* Effect.promise(() =>
        Promise.all([
          runInDurableObject(
            env.ROUTER_PROVIDED.getByName("no-alarm"),
            (instance) => "alarm" in instance,
          ),
          runInDurableObject(room("has-alarm"), (instance) => "alarm" in instance),
        ]),
      );

      expect(handlers).toEqual([false, true]);
    }),
  );

  it.effect("runs a subclass's alarm, which reaches make's through super", () =>
    Effect.gen(function* () {
      const stub = env.EXTENDED.getByName("extended");

      yield* setAlarm(stub);

      expect(yield* Effect.promise(() => runDurableObjectAlarm(stub))).toBe(true);

      const ran = yield* Effect.promise(() =>
        runInDurableObject(stub, (_, state) =>
          Promise.all([state.storage.get("extended"), state.storage.get("alarms")]),
        ),
      );

      expect(ran).toEqual([true, 1]);
    }),
  );

  it.effect(
    "leaves a socket the subclass accepted to its override, and serves rpcs beside it",
    () =>
      Effect.gen(function* () {
        const stub = env.OWN_SOCKETS.getByName("own-sockets");
        const own = yield* upgradeTo(stub, "https://object/own");
        const answer = nextMessage(own);

        own.send("hello");

        expect(yield* answer).toBe("hello");

        const client = yield* scopedClientOver(yield* upgradeToRpc(stub, bearer("ada")));

        expect(yield* client.whoami()).toBe("ada");
      }).pipe(Effect.scoped),
  );
});
