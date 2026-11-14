import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Logger, Schedule, Schema, Stream } from "effect";
import {
  ClusterError,
  MessageStorage,
  RunnerHealth,
  Runners,
  RunnerStorage,
  Sharding,
  ShardingConfig,
  Snowflake,
} from "effect/cluster";
import { Sse } from "effect/encoding";
import { Headers, HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientResponse } from "effect/http";
import { RpcClient } from "effect/rpc";

import * as Authentication from "../../src/authentication/Authentication.js";
import * as Event from "../../src/contract/Event.js";
import { PushedOf } from "../../src/contract/push.js";
import * as ActionEntity from "../../src/entity/ActionEntity.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import { DeclaredFailure } from "../../src/rpc/erased.js";
import * as Testing from "../../src/testing/Testing.js";
import * as Webhook from "../../src/webhook/Webhook.js";
import { verify } from "../support/app/authentication.js";
import { CurrentActor } from "../support/app/authorization.js";
import { framesOf } from "../support/sse.js";
import { Ticked } from "../support/ticked.js";
import { secretOf } from "../support/webhook.js";

class Unavailable extends Schema.TaggedError<
  Unavailable,
  { readonly brand: unique symbol }
>()("Unavailable", { issuer: Schema.String }, { httpApiStatus: 503 }) {}

const Principal = Authentication.make("reaching.Principal", CurrentActor, {
  principal: (actor) => actor.id,
  error: Unavailable,
});

const signIn = Authentication.layer(Principal, verify);

const Ticker = ActionEntity.make(
  "Ticker",
  ActionRpc.make([Ticked], { authentication: Principal }),
  { key: { ticked: ({ room }) => room } }
);

const TickerHttp = ActionHttp.make([Ticked], { authentication: Principal });

const failingPolls = (fails: (call: number) => boolean, lasting: boolean) => {
  let calls = 0;

  const runners = Layer.effect(
    Runners.Runners,
    Effect.map(Runners.makeNoop, (noop) =>
      Runners.Runners.of({
        ...noop,
        sendLocal: (options) => {
          const { message } = options;

          if (
            message._tag === "OutgoingRequest" &&
            message.envelope.tag === "ticked/poll"
          ) {
            calls += 1;

            if (fails(calls)) {
              return Effect.fail(
                lasting
                  ? new ClusterError.AlreadyProcessingMessage({
                      envelopeId: message.envelope.requestId,
                      address: message.envelope.address,
                    })
                  : new ClusterError.PersistenceError({
                      cause: new Error("storage down"),
                    })
              );
            }
          }

          return noop.sendLocal(options);
        },
      })
    )
  ).pipe(Layer.provide(Snowflake.layerGenerator));

  return Sharding.layer.pipe(
    Layer.provideMerge(runners),
    Layer.provideMerge(MessageStorage.layerMemory),
    Layer.provide([RunnerStorage.layerMemory, RunnerHealth.layerNoop]),
    Layer.provide(ShardingConfig.layer())
  );
};

interface TickerOptions {
  readonly fails?: (call: number) => boolean;
  readonly lasting?: boolean;
  readonly entityUnavailable?: (call: number) => boolean;
  readonly requestScoped?: boolean;
  readonly entityWebhooks?: boolean;
  readonly notified?: boolean;
}

const challengeIn = (body: string) =>
  /"challenge":"(?<challenge>[^"]+)"/u.exec(body)?.groups?.["challenge"];

const makeTicker = ({
  fails = () => false,
  lasting = false,
  entityUnavailable = () => false,
  requestScoped = true,
  entityWebhooks = false,
  notified = true,
}: TickerOptions = {}) => {
  const counted = {
    checks: 0,
    callbacks: 0,
    hooked: 0,
    unhooked: 0,
    verified: 0,
  };

  const ticks: number[] = [];
  const received: Array<{ readonly url: string; readonly body: string }> = [];

  const ticking = Event.implement(
    Ticked,
    {
      notified,
      check: (_input, cursor) =>
        Effect.sync(() => {
          counted.checks += 1;

          return {
            cursor: String(ticks.length),
            events: ticks
              .slice(cursor === null ? ticks.length : Number(cursor))
              .map((at) => ({ data: { at } })),
            nextPoll: "1 second",
          };
        }),
      subscription: () =>
        Effect.acquireRelease(
          Effect.sync(() => {
            counted.hooked += 1;
          }),
          () =>
            Effect.sync(() => {
              counted.unhooked += 1;
            })
        ),
    },
    { authorize: Event.allowAll }
  );

  const receiver = async (request: Request) => {
    const challenge = challengeIn(await request.text());

    counted.callbacks += 1;

    return challenge === undefined
      ? new Response(null, { status: 200 })
      : Response.json({ challenge });
  };

  const entityReceiver = async (request: Request) => {
    const body = await request.text();
    const challenge = challengeIn(body);

    received.push({ url: request.url, body });

    if (challenge === undefined) {
      return new Response(null, { status: 200 });
    }

    return Response.json({
      challenge: request.url.endsWith("/wrong") ? "wrong" : challenge,
    });
  };

  const reached = ActionEntity.reaching(Ticker);

  const edge = Layer.mergeAll(
    ActionHttp.layer(TickerHttp, reached),
    ActionMcp.layerHttp(reached, {
      name: "worker",
      version: "0.0.0",
      authentication: Principal,
      requestScoped,
    })
  ).pipe(
    Layer.provide(signIn),
    Layer.provide(Webhook.layer({ resolveCallbacks: false })),
    Layer.provide(Testing.layer(receiver))
  );

  const entitySignIn = Authentication.layer(Principal, (token) => {
    counted.verified += 1;

    return entityUnavailable(counted.verified)
      ? Effect.fail(new Unavailable({ issuer: "auth.example.com" }))
      : verify(token);
  });

  const entities = ActionEntity.layer(Ticker, ticking, {
    services: entityWebhooks
      ? Webhook.layer({ resolveCallbacks: false }).pipe(
          Layer.provide(Testing.layer(entityReceiver))
        )
      : Layer.empty,
  }).pipe(
    Layer.provideMerge(failingPolls(fails, lasting)),
    Layer.provide(entitySignIn),
    Layer.provideMerge(Event.layerMemory)
  );

  const tick = (at: number) =>
    Effect.andThen(
      Effect.sync(() => ticks.push(at)),
      Effect.flatMap(Event.Events, (events) => events.notify(Ticked))
    );

  return {
    counted,
    ticks,
    tick,
    received,
    server: Testing.layer(edge).pipe(Layer.provideMerge(entities)),
  };
};

const Json = Schema.fromJsonString(Schema.Json);

const asAlice = { headers: { authorization: "Bearer alice" } };

const mcpSent = (method: string, params: ActionMcp.Params) =>
  Effect.flatMap(
    HttpClient.execute(ActionMcp.request(method, params, asAlice)),
    (response) => Effect.flatMap(response.text, Schema.decodeEffect(Json))
  );

const delivery = {
  url: "https://hooks.example.com/alice",
  secret: secretOf(1),
};

const until = (done: () => boolean) =>
  Effect.sync(done).pipe(
    Effect.repeat({
      until: (held) => held,
      schedule: Schedule.spaced("20 millis"),
      times: 500,
    }),
    Effect.flatMap((held) =>
      held ? Effect.void : Effect.die(new Error(`Never held: ${String(done)}`))
    )
  );

const subscribeOverHttp = (
  path: "subscribe" | "unsubscribe",
  room: string,
  url: string,
  headers: Record<string, string> = asAlice.headers
) =>
  HttpClient.execute(
    HttpClientRequest.post(`/api/events/ticked/${path}`).pipe(
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.bodyJsonUnsafe({
        input: { room },
        delivery:
          path === "subscribe" ? { url, secret: delivery.secret } : { url },
      })
    )
  );

const carol = "https://hooks.example.com/carol";

const occurrencesIn = (
  received: ReadonlyArray<{ readonly url: string; readonly body: string }>,
  url: string
) =>
  received.filter(
    (each) => each.url === url && each.body.includes('"name":"ticked"')
  );

describe("ActionEntity.reaching's events by webhook", () => {
  it.live(
    "holds a subscription made over HTTP or MCP in the entity its input's key names, which delivers each occurrence and stops at the unsubscribe, the surface's own Webhook.layer holding none",
    () => {
      const { counted, tick, received, server } = makeTicker({
        entityWebhooks: true,
      });

      return Effect.gen(function* () {
        const listed = yield* mcpSent("events/list", {});

        const overHttp = yield* subscribeOverHttp(
          "subscribe",
          "a",
          delivery.url
        );

        const overMcp = yield* mcpSent("events/subscribe", {
          name: "ticked",
          arguments: { room: "b" },
          delivery: {
            mode: "webhook",
            url: "https://hooks.example.com/bob",
            secret: delivery.secret,
          },
        });

        yield* subscribeOverHttp("subscribe", "b", carol);

        yield* tick(1);

        yield* until(
          () =>
            occurrencesIn(received, delivery.url).length === 1 &&
            occurrencesIn(received, "https://hooks.example.com/bob").length ===
              1 &&
            occurrencesIn(received, carol).length === 1
        );

        const unsubscribed = yield* subscribeOverHttp(
          "unsubscribe",
          "a",
          delivery.url
        );

        yield* tick(2);

        yield* until(
          () =>
            occurrencesIn(received, "https://hooks.example.com/bob").length ===
            2
        );

        const unsubscribedOverMcp = yield* mcpSent("events/unsubscribe", {
          name: "ticked",
          arguments: { room: "b" },
          delivery: { mode: "webhook", url: "https://hooks.example.com/bob" },
        });

        yield* until(() => counted.unhooked === 2);

        yield* tick(3);

        yield* until(() => occurrencesIn(received, carol).length === 3);

        expect(unsubscribedOverMcp).toMatchObject({ result: {} });
        expect(
          occurrencesIn(received, "https://hooks.example.com/bob")
        ).toHaveLength(2);
        expect(listed).toMatchObject({
          result: {
            events: [{ name: "ticked", delivery: ["poll", "webhook"] }],
          },
        });
        expect(overHttp.status).toBe(200);
        expect(yield* overHttp.json).toMatchObject({ cursor: "0" });
        expect(overMcp).toMatchObject({ result: { cursor: "0" } });
        expect(unsubscribed.status).toBe(204);
        expect(occurrencesIn(received, delivery.url)).toHaveLength(1);
        expect(counted.callbacks).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(server));
    }
  );

  it.live(
    "answers the entity's own refusal of a callback, CallbackFailed over HTTP and MCP, its category passed back",
    () => {
      const { received, server } = makeTicker({ entityWebhooks: true });

      return Effect.gen(function* () {
        const overHttp = yield* subscribeOverHttp(
          "subscribe",
          "a",
          "https://hooks.example.com/wrong"
        );

        const overMcp = yield* mcpSent("events/subscribe", {
          name: "ticked",
          arguments: { room: "a" },
          delivery: {
            mode: "webhook",
            url: "https://hooks.example.com/wrong",
            secret: delivery.secret,
          },
        });

        expect(overHttp.status).toBe(409);
        expect(yield* overHttp.json).toMatchObject({
          _tag: "SubscriptionError",
          reason: { _tag: "CallbackFailed", category: "challenge_failed" },
        });
        expect(overMcp).toMatchObject({
          error: { data: { reason: "challenge_failed" } },
        });
        expect(received).toHaveLength(2);
      }).pipe(Effect.scoped, Effect.provide(server));
    }
  );

  it.live(
    "offers webhook delivery for a reached protected event, and the entity holding no Webhook.layer refuses a subscription with Unsupported, a 409 over HTTP, before any callback is sent",
    () => {
      const { counted, server } = makeTicker();

      return Effect.gen(function* () {
        const listed = yield* mcpSent("events/list", {});

        const overMcp = yield* mcpSent("events/subscribe", {
          name: "ticked",
          arguments: { room: "a" },
          delivery: { mode: "webhook", ...delivery },
        });

        const overHttp = yield* subscribeOverHttp(
          "subscribe",
          "a",
          delivery.url
        );

        expect(listed).toMatchObject({
          result: {
            events: [{ name: "ticked", delivery: ["poll", "webhook"] }],
          },
        });
        expect(overMcp).toMatchObject({
          error: { data: { feature: "deliveryMode", value: "webhook" } },
        });
        expect(overHttp.status).toBe(409);
        expect(yield* overHttp.json).toMatchObject({
          _tag: "SubscriptionError",
          reason: { _tag: "Unsupported", value: "webhook" },
        });
        expect(counted).toMatchObject({ checks: 0, callbacks: 0, hooked: 0 });
        expect(counted.verified).toBeGreaterThan(0);
      }).pipe(Effect.scoped, Effect.provide(server));
    }
  );

  it.live(
    "refuses, in an entity holding a Webhook.layer, a webhook subscription to a check source not notified, with Unsupported before any callback, logging why, and serves its polls and unsubscribes",
    () => {
      const { counted, ticks, received, server } = makeTicker({
        entityWebhooks: true,
        notified: false,
      });

      const warnings: string[] = [];

      const logger = Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn") {
          warnings.push(String(message));
        }
      });

      return Effect.gen(function* () {
        const overHttp = yield* subscribeOverHttp(
          "subscribe",
          "a",
          delivery.url
        );

        const overMcp = yield* mcpSent("events/subscribe", {
          name: "ticked",
          arguments: { room: "a" },
          delivery: { mode: "webhook", ...delivery },
        });

        const unsubscribed = yield* subscribeOverHttp(
          "unsubscribe",
          "a",
          delivery.url
        );

        const hookedBeforePoll = counted.hooked;

        ticks.push(1);

        const polled = yield* HttpClient.execute(
          HttpClientRequest.post("/api/events/ticked").pipe(
            HttpClientRequest.setHeaders(asAlice.headers),
            HttpClientRequest.bodyJsonUnsafe({
              input: { room: "a" },
              cursor: "0",
            })
          )
        );

        expect(overHttp.status).toBe(409);
        expect(yield* overHttp.json).toMatchObject({
          _tag: "SubscriptionError",
          reason: {
            _tag: "Unsupported",
            feature: "deliveryMode",
            value: "webhook",
          },
        });
        expect(overMcp).toMatchObject({
          error: { data: { feature: "deliveryMode", value: "webhook" } },
        });
        expect(yield* unsubscribed.json).toMatchObject({
          reason: { _tag: "NotSubscribed" },
        });
        expect(received).toStrictEqual([]);
        expect(hookedBeforePoll).toBe(0);
        expect(polled.status).toBe(200);
        expect(yield* polled.json).toMatchObject({
          events: [{ data: { at: 1 } }],
        });
        expect(warnings).toStrictEqual([
          expect.stringContaining("mark the source notified"),
          expect.stringContaining("mark the source notified"),
        ]);
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.provideMerge(server, Logger.layer([logger])))
      );
    }
  );

  it.live(
    "refuses a webhook subscription without a credential at the surface, reaching no entity and sending no callback",
    () => {
      const { counted, received, server } = makeTicker({
        entityWebhooks: true,
      });

      return Effect.gen(function* () {
        const overHttp = yield* subscribeOverHttp(
          "subscribe",
          "a",
          delivery.url,
          {}
        );

        const overMcp = yield* Effect.map(
          HttpClient.execute(
            ActionMcp.request("events/subscribe", {
              name: "ticked",
              arguments: { room: "a" },
              delivery: { mode: "webhook", ...delivery },
            })
          ),
          (response) => response.status
        );

        expect(overHttp.status).toBe(401);
        expect(overMcp).toBe(401);
        expect(counted.verified).toBe(0);
        expect(received).toHaveLength(0);
      }).pipe(Effect.scoped, Effect.provide(server));
    }
  );
});

const sentOf = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(PushedOf(Ticked)))
);

const pushedFrames = (response: HttpClientResponse.HttpClientResponse) =>
  response.stream.pipe(
    Stream.decodeText,
    Stream.pipeThroughChannel(Sse.decode()),
    Stream.mapEffect((frame) => sentOf(frame.data))
  );

describe("ActionEntity.reaching's event streams", () => {
  it.live(
    "ask the entity again after a transient cluster failure, from where the stream reached, in the same stream",
    () => {
      const { counted, ticks, server } = makeTicker({
        fails: (call) => call === 2,
      });

      return Effect.gen(function* () {
        const http = yield* ActionHttp.client(TickerHttp, {
          transformClient: HttpClient.mapRequest(
            HttpClientRequest.bearerToken("alice")
          ),
        });

        const received: number[] = [];

        ticks.push(1);

        const watched = yield* Effect.forkScoped(
          http.watch(Ticked, { room: "a" }, { cursor: "0" }).pipe(
            Stream.take(2),
            Stream.runForEach((item) =>
              Effect.sync(() => {
                received.push(item._tag === "Occurrence" ? item.data.at : -1);
              })
            )
          )
        );

        yield* until(() => received.length === 1);

        ticks.push(2);

        yield* Fiber.join(watched);

        expect(received).toStrictEqual([1, 2]);
        expect(counted.hooked).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(server));
    },
    { timeout: 30_000 }
  );

  it.live(
    "end on a cluster failure no retry outlasts, which the HTTP stream reports as Failed and opens again under a hook of its own",
    () => {
      const { counted, ticks, server } = makeTicker({
        fails: (call) => call === 2,
        lasting: true,
      });

      return Effect.gen(function* () {
        const http = yield* ActionHttp.client(TickerHttp, {
          transformClient: HttpClient.mapRequest(
            HttpClientRequest.bearerToken("alice")
          ),
        });

        const received: number[] = [];

        ticks.push(1);

        const watched = yield* Effect.forkScoped(
          http.watch(Ticked, { room: "a" }, { cursor: "0" }).pipe(
            Stream.take(2),
            Stream.runForEach((item) =>
              Effect.sync(() => {
                received.push(item._tag === "Occurrence" ? item.data.at : -1);
              })
            )
          )
        );

        yield* until(() => received.length === 1);

        ticks.push(2);

        yield* Fiber.join(watched);
        yield* until(() => counted.unhooked === 2);

        expect(received).toStrictEqual([1, 2]);
        expect(counted).toMatchObject({ hooked: 2, unhooked: 2 });
      }).pipe(Effect.scoped, Effect.provide(server));
    },
    { timeout: 30_000 }
  );

  it.live(
    "end on an error the entity's verifier declares, which the HTTP stream sends as Failed and opens again under a hook of its own",
    () => {
      const { counted, ticks, server } = makeTicker({
        entityUnavailable: (call) => call === 2,
      });

      return Effect.gen(function* () {
        ticks.push(1);

        const response = yield* HttpClient.execute(
          HttpClientRequest.post("/api/events/ticked").pipe(
            HttpClientRequest.setHeaders({
              ...asAlice.headers,
              accept: "text/event-stream",
            }),
            HttpClientRequest.bodyJsonUnsafe({
              input: { room: "a" },
              cursor: "0",
            })
          )
        );

        const frames = yield* pushedFrames(response).pipe(
          Stream.tap((sent) =>
            Effect.sync(() => {
              if (sent._tag === "Failed") {
                ticks.push(2);
              }
            })
          ),
          Stream.takeUntil(
            (sent) => sent._tag === "Occurrence" && sent.data.at === 2
          ),
          Stream.runCollect
        );

        yield* until(() => counted.unhooked === 2);

        expect(frames).toMatchObject([
          { _tag: "Checked", cursor: "0" },
          { _tag: "Occurrence", cursor: "1", data: { at: 1 } },
          { _tag: "Failed" },
          { _tag: "Occurrence", cursor: "2", data: { at: 2 } },
        ]);
        expect(JSON.stringify(frames)).not.toContain("auth.example.com");
        expect(counted).toMatchObject({ hooked: 2, unhooked: 2 });
      }).pipe(Effect.scoped, Effect.provide(server));
    },
    { timeout: 30_000 }
  );

  it.live(
    "end on an error the entity's verifier declares before MCP's events/stream is active, which answers -32603 and opens it no more, where one admitted is active",
    () => {
      const { counted, server } = makeTicker({
        entityUnavailable: (call) => call === 1,
        requestScoped: false,
      });

      return Effect.gen(function* () {
        const streamed = HttpClient.execute(
          ActionMcp.request(
            "events/stream",
            { name: "ticked", arguments: { room: "a" }, cursor: null },
            asAlice
          )
        );

        const answered = yield* Effect.scoped(
          Effect.flatMap(streamed, (response) =>
            response.text.pipe(
              Effect.timeout("5 seconds"),
              Effect.flatMap(Schema.decodeEffect(Json))
            )
          )
        );

        const beforeAdmitted = { ...counted };

        const [active] = yield* Effect.scoped(
          Effect.flatMap(streamed, (response) => framesOf(response, 1))
        );

        expect(answered).toMatchObject({
          error: { code: -32_603, message: "Internal error" },
        });
        expect(beforeAdmitted).toMatchObject({ checks: 0, hooked: 0 });
        expect(active?.data).toMatchObject({
          method: "notifications/events/active",
        });
      }).pipe(Effect.scoped, Effect.provide(server));
    },
    { timeout: 30_000 }
  );

  it.live(
    "release the subscription hook their polls hold in the entity as each closes, leaving another stream's of the same input held",
    () => {
      const { counted, server } = makeTicker();

      return Effect.gen(function* () {
        const http = yield* ActionHttp.client(TickerHttp, {
          transformClient: HttpClient.mapRequest(
            HttpClientRequest.bearerToken("alice")
          ),
        });

        const opened = Effect.forkScoped(
          Stream.runDrain(http.watch(Ticked, { room: "a" }))
        );

        const first = yield* opened;

        yield* until(() => counted.hooked === 1);

        const second = yield* opened;

        yield* until(() => counted.hooked === 2);
        yield* Fiber.interrupt(first);
        yield* until(() => counted.unhooked === 1);

        const checked = counted.checks;

        yield* until(() => counted.checks > checked);

        const whileSecondOpen = { ...counted };

        yield* Fiber.interrupt(second);
        yield* until(() => counted.unhooked === 2);

        expect(whileSecondOpen).toMatchObject({ hooked: 2, unhooked: 1 });
        expect(counted).toMatchObject({ hooked: 2, unhooked: 2 });
      }).pipe(Effect.scoped, Effect.provide(server));
    },
    { timeout: 30_000 }
  );
});

const signedIn = (token: string) =>
  Stream.updateService(
    RpcClient.CurrentHeaders,
    Headers.merge(Headers.fromInput({ authorization: `Bearer ${token}` }))
  );

describe("ActionEntity.client's watches", () => {
  it.live(
    "each hold a subscription hook of their own in the entity, which each releases as it ends, interrupted or done",
    () => {
      const { counted, ticks, server } = makeTicker();

      return Effect.gen(function* () {
        const a = (yield* ActionEntity.client(Ticker))("a");

        const watched = (options?: Event.WatchOptions) =>
          a.watch(Ticked, { room: "a" }, options).pipe(signedIn("alice"));

        const first = yield* Effect.forkScoped(Stream.runDrain(watched()));

        yield* until(() => counted.hooked === 1);

        const second = yield* Effect.forkScoped(
          Stream.runDrain(watched({ mode: "poll" }))
        );

        yield* until(() => counted.hooked === 2);
        yield* Fiber.interrupt(first);
        yield* until(() => counted.unhooked === 1);

        const checked = counted.checks;

        yield* until(() => counted.checks > checked);

        const whileSecondOpen = { ...counted };

        yield* Fiber.interrupt(second);
        yield* until(() => counted.unhooked === 2);

        ticks.push(1);

        const taken = yield* Stream.runCollect(
          watched({ cursor: "0" }).pipe(Stream.take(1))
        );

        yield* until(() => counted.unhooked === 3);

        expect(whileSecondOpen).toMatchObject({ hooked: 2, unhooked: 1 });
        expect(taken).toMatchObject([{ _tag: "Occurrence", data: { at: 1 } }]);
        expect(counted).toMatchObject({ hooked: 3, unhooked: 3 });
      }).pipe(Effect.scoped, Effect.provide(server));
    },
    { timeout: 30_000 }
  );

  it.live(
    "ask the entity again after a transient cluster failure, from where the watch reached, under the hook it held",
    () => {
      const { counted, ticks, server } = makeTicker({
        fails: (call) => call === 2,
      });

      return Effect.gen(function* () {
        const a = (yield* ActionEntity.client(Ticker))("a");
        const received: number[] = [];

        ticks.push(1);

        const watched = yield* Effect.forkScoped(
          a.watch(Ticked, { room: "a" }, { cursor: "0" }).pipe(
            signedIn("alice"),
            Stream.take(2),
            Stream.runForEach((item) =>
              Effect.sync(() => {
                received.push(item._tag === "Occurrence" ? item.data.at : -1);
              })
            )
          )
        );

        yield* until(() => received.length === 1);

        ticks.push(2);

        yield* Fiber.join(watched);
        yield* until(() => counted.unhooked === 1);

        expect(received).toStrictEqual([1, 2]);
        expect(counted).toMatchObject({ hooked: 1, unhooked: 1 });
      }).pipe(Effect.scoped, Effect.provide(server));
    },
    { timeout: 30_000 }
  );
});

const rpcOfRoomA = Effect.map(Ticker.client, (clientFor) => {
  const rpcs = clientFor("a");

  return (
    tag: string,
    payload: Schema.Json,
    headers: Record<string, string>
  ) => {
    const answer = rpcs[tag]?.(payload, { headers });

    return answer !== undefined && Effect.isEffect(answer)
      ? answer
      : Effect.die(new Error(`no unary rpc ${tag}`));
  };
});

const refusalOf = (refused: unknown) =>
  refused instanceof DeclaredFailure ? refused.json : refused;

describe("An entity's release rpc", () => {
  it.live(
    "frees the hook a watch's polls hold for their own principal alone, and refuses a caller without a credential",
    () => {
      const { counted, server } = makeTicker();

      return Effect.gen(function* () {
        const sent = yield* rpcOfRoomA;
        const input = { room: "a" };
        const watch = "6f1c2a4e-8b3d-4c5e-9a7f-0d1e2f3a4b5c";
        const polled = { input, cursor: null, watch };
        const released = { input, watch };
        const asBob = { authorization: "Bearer bob" };

        yield* sent("ticked/poll", polled, asAlice.headers);
        yield* sent("ticked/release", released, asBob);

        const refused = yield* Effect.flip(
          sent("ticked/release", released, {})
        );

        yield* sent("ticked/poll", polled, asAlice.headers);

        const beforeAlice = { ...counted };

        yield* sent("ticked/release", released, asAlice.headers);
        yield* until(() => counted.unhooked > beforeAlice.unhooked);

        expect(refusalOf(refused)).toMatchObject({ _tag: "Unauthenticated" });
        expect(beforeAlice).toMatchObject({ hooked: 1, unhooked: 0 });
        expect(counted).toMatchObject({ hooked: 1, unhooked: 1 });
      }).pipe(Effect.scoped, Effect.provide(server));
    }
  );

  it.live("refuses a watch that is no UUID with InvalidInput", () => {
    const { counted, server } = makeTicker();

    return Effect.gen(function* () {
      const sent = yield* rpcOfRoomA;
      const input = { room: "a" };
      const watch = "w".repeat(36);

      const refusals = yield* Effect.forEach(
        [
          ["ticked/poll", { input, cursor: null, watch }],
          ["ticked/release", { input, watch }],
        ] as const,
        ([tag, payload]) => Effect.flip(sent(tag, payload, asAlice.headers))
      );

      expect(refusals.map(refusalOf)).toMatchObject([
        { _tag: "InvalidInput" },
        { _tag: "InvalidInput" },
      ]);
      expect(counted).toMatchObject({ checks: 0, hooked: 0 });
    }).pipe(Effect.scoped, Effect.provide(server));
  });
});
