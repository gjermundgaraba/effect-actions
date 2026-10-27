import { describe, expect, it } from "@effect/vitest";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DateTime, Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http";

import * as ActionDurableObject from "../../src/durable/ActionDurableObject.js";
import { dueNow, runAlarmDue } from "../support/alarm.js";
import {
  alarmBuildsKey,
  Builds,
  Http,
  ownTag,
  readyKey,
} from "../support/app.js";
import {
  nextMessage,
  scopedClientOver,
  upgradeTo,
  upgradeToRpc,
} from "../support/socket.js";
import type { OwnSockets, Room } from "../worker.js";

const room = (name: string) => env.ROOM.getByName(name);

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const textOf = (response: Response) =>
  Effect.promise(async () => await response.text());

const setAlarm = (stub: DurableObjectStub) =>
  Effect.promise(async () => {
    await runInDurableObject(stub, async (_, state) => {
      await Effect.runPromise(
        Effect.flatMap(
          Effect.map(DateTime.now, DateTime.add({ minutes: 1 })),
          (at) => ActionDurableObject.Alarm.use((alarm) => alarm.set(at))
        ).pipe(
          Effect.provide(ActionDurableObject.Alarm.layer),
          Effect.provideService(ActionDurableObject.State, state)
        )
      );
    });
  });

const stored = (stub: DurableObjectStub, key: string) =>
  Effect.promise(
    async () =>
      await runInDurableObject(
        stub,
        async (_, state) => await state.storage.get(key)
      )
  );

describe("handlers", () => {
  it.effect(
    "serves the routes' JSON over fetch, built with the object's State",
    () =>
      Effect.gen(function* () {
        const client = yield* ActionHttp.client(Http, {
          baseUrl: "https://object",
          transformClient: HttpClient.mapRequest(
            HttpClientRequest.bearerToken("ada")
          ),
        });

        expect(yield* client.whoami()).toBe("ada");
        expect(yield* client.alarms()).toBe(0);
      }).pipe(
        Effect.provide(ActionDurableObject.layerHttpClient(room("fetch")))
      )
  );

  it.effect("gives each request a service the routes provide themselves", () =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(
        async () => await room("greeting").fetch("https://object/greeting")
      );

      expect(yield* textOf(response)).toBe("hello");
    })
  );

  it.effect("fails every request with the routes' build failure", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Effect.tryPromise(
          async () =>
            await env.BROKEN.getByName("broken").fetch("https://object/")
        )
      );

      expect(String(failure.cause)).toContain("Unreachable");
    })
  );

  it.effect(
    "builds the services once for the routes, a stub method's run and the alarm",
    () =>
      Effect.gen(function* () {
        const stub = env.COUNTED.getByName("fetched-first");

        const response = yield* Effect.promise(
          async () => await stub.fetch("https://object/builds")
        );

        expect(yield* textOf(response)).toBe("1");
        expect(yield* Effect.promise(async () => await stub.builds())).toBe(1);

        yield* setAlarm(stub);

        expect(yield* runAlarmDue(stub)).toBe(true);
        expect(yield* stored(stub, alarmBuildsKey)).toBe(1);
        expect(yield* Effect.promise(async () => await stub.builds())).toBe(1);
      })
  );

  it.effect("builds once for two first events arriving while it builds", () =>
    Effect.gen(function* () {
      const stub = env.COUNTED.getByName("concurrent");

      const [response, builds] = yield* Effect.promise(
        async () =>
          await Promise.all([
            stub.fetch("https://object/builds"),
            stub.builds(),
          ])
      );

      expect([yield* textOf(response), builds]).toStrictEqual(["1", 1]);
    })
  );

  it.effect(
    "runs a stub method on an instance never fetched once the services are built",
    () =>
      Effect.gen(function* () {
        const stub = env.COUNTED.getByName("called-first");

        expect(yield* Effect.promise(async () => await stub.builds())).toBe(1);

        const response = yield* Effect.promise(
          async () => await stub.fetch("https://object/builds")
        );

        expect(yield* textOf(response)).toBe("1");
      })
  );

  it.effect(
    "builds the services a function of the instance's env returns",
    () =>
      Effect.gen(function* () {
        const greeting = yield* Effect.promise(
          async () => await env.FROM_ENV.getByName("env").greeting()
        );

        expect(greeting).toBe("from the deployment");
      })
  );

  it.effect("builds a Layer a run provides itself for that run alone", () =>
    Effect.gen(function* () {
      const stub = env.COUNTED.getByName("provided");

      expect(yield* Effect.promise(async () => await stub.builds())).toBe(1);
      expect(
        yield* Effect.promise(async () => await stub.providedBuilds())
      ).toBe(2);
      expect(
        yield* Effect.promise(async () => await stub.providedBuilds())
      ).toBe(3);
      expect(yield* Effect.promise(async () => await stub.builds())).toBe(1);
    })
  );

  it.effect("fails fetch and run with the services' build failure", () =>
    Effect.gen(function* () {
      const stub = env.BROKEN_SERVICES.getByName("broken-services");

      const failures = yield* Effect.all([
        Effect.flip(
          Effect.tryPromise(async () => await stub.fetch("https://object/"))
        ),
        Effect.flip(
          Effect.tryPromise(async () => {
            await runInDurableObject(stub, async (instance) => {
              await instance.run(Effect.void);
            });
          })
        ),
      ]);

      for (const failure of failures) {
        expect(String(failure.cause)).toContain("Unreachable");
      }
    })
  );

  it.effect("rejects run with the routes' build failure", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Effect.tryPromise(async () => {
          await runInDurableObject(
            env.BROKEN.getByName("broken-run"),
            async (instance) => {
              await instance.run(Effect.void);
            }
          );
        })
      );

      expect(String(failure.cause)).toContain("Unreachable");
    })
  );

  it.effect(
    "builds everything again from nothing on the event after a failed build",
    () =>
      Effect.gen(function* () {
        const stub = env.RETRIED.getByName("retried");

        const failure = yield* Effect.flip(
          Effect.tryPromise(
            async () => await stub.fetch("https://object/builds")
          )
        );

        expect(String(failure.cause)).toContain("NotReady");

        yield* Effect.promise(async () => {
          await runInDurableObject(stub, async (_, state) => {
            await state.storage.put(readyKey, true);
          });
        });

        const client = yield* scopedClientOver(
          yield* upgradeToRpc(stub, bearer("ada"))
        );

        expect(yield* client.whoami()).toBe("ada");

        const response = yield* Effect.promise(
          async () => await stub.fetch("https://object/builds")
        );

        expect(yield* textOf(response)).toBe("3");
      }).pipe(Effect.scoped)
  );

  it.effect(
    "fails a build whose web handler fails as it is made, finalizing what it built, and builds again",
    () =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(
          async () =>
            await runInDurableObject(room("handler-made"), async (_, state) => {
              const counts = { builds: 0, finalized: 0 };

              const object = ActionDurableObject.handlers(state, {
                services: Layer.effectDiscard(
                  Effect.acquireRelease(
                    Effect.sync(() => {
                      counts.builds += 1;
                    }),
                    () =>
                      Effect.sync(() => {
                        counts.finalized += 1;
                      })
                  )
                ),
                routes: HttpRouter.middleware(
                  (effect) => {
                    if (counts.builds === 1) {
                      throw new Error("handler made once");
                    }

                    return effect;
                  },
                  { global: true }
                ),
                disableLogger: true,
              });

              const fetched = async () =>
                await object
                  .fetch(new Request("https://object/"))
                  .then((response) => response.status, String);

              const first = await fetched();

              return { first, second: await fetched(), ...counts };
            })
        );

        expect(result).toStrictEqual({
          first: "Error: handler made once",
          second: 404,
          builds: 2,
          finalized: 1,
        });
      })
  );

  it.effect(
    "builds again on the event after a build that failed before it awaited anything",
    () =>
      Effect.gen(function* () {
        const stub = env.RETRIED_AT_ONCE.getByName("retried-at-once");

        const failure = yield* Effect.flip(
          Effect.tryPromise(
            async () => await stub.fetch("https://object/ready")
          )
        );

        expect(String(failure.cause)).toContain("NotReady");

        yield* Effect.promise(async () => {
          await runInDurableObject(stub, (_, state) => {
            state.storage.kv.put(readyKey, true);
          });
        });

        const response = yield* Effect.promise(
          async () => await stub.fetch("https://object/ready")
        );

        expect(yield* textOf(response)).toBe("ready");
      })
  );

  it.effect(
    "runs the alarm on a woken instance once the routes are built, sharing their services",
    () =>
      Effect.gen(function* () {
        const stub = room("alarm");

        const client = yield* ActionHttp.client(Http, {
          baseUrl: "https://object",
          transformClient: HttpClient.mapRequest(
            HttpClientRequest.bearerToken("ada")
          ),
        });

        yield* client.schedule();
        yield* dueNow(stub);
        yield* Effect.promise(async () => {
          await evictDurableObject(stub);
        });

        expect(
          yield* Effect.promise(async () => await runDurableObjectAlarm(stub))
        ).toBe(true);
        expect(yield* client.alarms()).toBe(1);
        expect(yield* client.spend({ amount: 9 })).toStrictEqual({ left: 0 });
      }).pipe(
        Effect.provide(ActionDurableObject.layerHttpClient(room("alarm")))
      )
  );

  it.effect(
    "serves a class of its own without routes, answering fetch with 404",
    () =>
      Effect.gen(function* () {
        const stub = env.HOSTED.getByName("hosted");

        const response = yield* Effect.promise(
          async () => await stub.fetch("https://object/builds")
        );

        expect(response.status).toBe(404);
        expect(yield* Effect.promise(async () => await stub.builds())).toBe(1);

        yield* setAlarm(stub);

        expect(yield* runAlarmDue(stub)).toBe(true);
        expect(yield* stored(stub, alarmBuildsKey)).toBe(1);
      })
  );

  it.effect(
    "resolves every socket handler's event on a socket no protocol accepted",
    () =>
      Effect.gen(function* () {
        const stub = env.OWN_SOCKETS.getByName("own-closes");

        yield* upgradeTo(stub, "https://object/own");

        yield* Effect.promise(async () => {
          await runInDurableObject(
            stub,
            async (instance: OwnSockets, state) => {
              const [held] = state.getWebSockets(ownTag);

              if (held === undefined) {
                throw new Error("No socket");
              }

              await expect(
                instance.webSocketError(held, new Error("lost"))
              ).resolves.toBeUndefined();
              await expect(
                instance.webSocketClose(held, 1000, "", true)
              ).resolves.toBeUndefined();
            }
          );
        });

        yield* Effect.promise(async () => {
          await runInDurableObject(
            room("foreign"),
            async (instance: Room, state) => {
              const { 1: server } = new WebSocketPair();

              state.acceptWebSocket(server, ["foreign"]);

              await expect(
                instance.webSocketMessage(server, "{}")
              ).resolves.toBeUndefined();
            }
          );
        });
      })
  );
  it.effect(
    "refuses a call over the stub without calls, naming the option",
    () =>
      Effect.gen(function* () {
        const refused = yield* Effect.promise(
          async () =>
            await runInDurableObject(
              env.HOSTED.getByName("nothing-served"),
              async (_, state) =>
                await ActionDurableObject.handlers(state, {
                  services: Builds.layer,
                })
                  .effectActionsRpc([])
                  .then(() => "answered", String)
            )
        );

        expect(refused).toContain("serves no rpcs over its stub");
      })
  );

  it.live(
    "defines the socket handlers on every class, and completes the closing handshake of a socket no protocol accepted, with routes or without",
    () =>
      Effect.gen(function* () {
        const names = ["webSocketMessage", "webSocketClose", "webSocketError"];

        const closedOwn = (stub: DurableObjectStub) =>
          Effect.promise(
            async () =>
              await runInDurableObject(stub, async (instance, state) => {
                const { 0: client, 1: server } = new WebSocketPair();

                state.acceptWebSocket(server, ["own"]);
                client.accept();

                const { promise: closed, resolve } =
                  Promise.withResolvers<CloseEvent>();

                client.addEventListener("close", resolve, { once: true });

                client.close(4000, "page left");

                const { code, reason, wasClean } = await closed;

                return {
                  handlers: names.filter((name) => name in instance),
                  closed: { code, reason, wasClean },
                };
              })
          ).pipe(Effect.timeout("2 seconds"));

        const expected = {
          handlers: names,
          closed: { code: 4000, reason: "page left", wasClean: true },
        };

        expect(yield* closedOwn(room("own-close"))).toStrictEqual(expected);
        expect(
          yield* closedOwn(env.STREAMED.getByName("own-close"))
        ).toStrictEqual(expected);
      })
  );
});

describe("make", () => {
  it.effect(
    "defines the alarm handler given an alarm or not, for the package's own times",
    () =>
      Effect.gen(function* () {
        const handlers = yield* Effect.promise(
          async () =>
            await Promise.all([
              runInDurableObject(
                env.ROUTER_PROVIDED.getByName("no-alarm"),
                (instance) => "alarm" in instance
              ),
              runInDurableObject(
                room("has-alarm"),
                (instance) => "alarm" in instance
              ),
            ])
        );

        expect(handlers).toStrictEqual([true, true]);
      })
  );

  it.effect("runs a subclass's alarm, which reaches make's through super", () =>
    Effect.gen(function* () {
      const stub = env.EXTENDED.getByName("extended");

      yield* setAlarm(stub);

      expect(yield* runAlarmDue(stub)).toBe(true);

      const ran = yield* Effect.promise(
        async () =>
          await runInDurableObject(
            stub,
            async (_, state) =>
              await Promise.all([
                state.storage.get("extended"),
                state.storage.get("alarms"),
              ])
          )
      );

      expect(ran).toStrictEqual([true, 1]);
    })
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

        const client = yield* scopedClientOver(
          yield* upgradeToRpc(stub, bearer("ada"))
        );

        expect(yield* client.whoami()).toBe("ada");
      }).pipe(Effect.scoped)
  );
});
