import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Schedule, Schema, Stream } from "effect";
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
import { HttpClient, HttpClientRequest } from "effect/http";
import { Dns } from "effect/net";

import * as Authentication from "../../src/authentication/Authentication.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionEntity from "../../src/entity/ActionEntity.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import * as Testing from "../../src/testing/Testing.js";
import * as Webhook from "../../src/webhook/Webhook.js";
import { verify } from "../support/app/authentication.js";
import { CurrentActor } from "../support/app/authorization.js";
import { secretOf } from "../support/webhook.js";

const Ticked = Event.make("ticked", {
  description: "A room ticked.",
  input: { room: Schema.String },
  payload: { at: Schema.Int },
  caller: CurrentActor,
});

const Principal = Authentication.make("reaching.Principal", CurrentActor, {
  principal: (actor) => actor.id,
});

const signIn = Authentication.layer(Principal, verify);

const Ticker = ActionEntity.make(
  "Ticker",
  ActionRpc.make([Ticked], { authentication: Principal }),
  { key: { ticked: ({ room }) => room } }
);

const TickerHttp = ActionHttp.make([Ticked], { authentication: Principal });

const failingPolls = (fails: (call: number) => boolean) => {
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
            message.envelope.tag === "ticked"
          ) {
            calls += 1;

            if (fails(calls)) {
              return Effect.fail(
                new ClusterError.PersistenceError({
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

const makeTicker = (fails: (call: number) => boolean = () => false) => {
  const counted = { checks: 0, callbacks: 0, hooked: 0, unhooked: 0 };
  const ticks: number[] = [];

  const ticking = Event.implement(
    Ticked,
    {
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
    const body = await request.text();

    const challenge = /"challenge":"(?<challenge>[^"]+)"/u.exec(body)?.groups?.[
      "challenge"
    ];

    counted.callbacks += 1;

    return challenge === undefined
      ? new Response(null, { status: 200 })
      : Response.json({ challenge });
  };

  const reached = ActionEntity.reaching(Ticker);

  const edge = Layer.mergeAll(
    ActionHttp.layer(TickerHttp, reached),
    ActionMcp.layerHttp(reached, {
      name: "worker",
      version: "0.0.0",
      authentication: Principal,
      requestScoped: true,
    })
  ).pipe(
    Layer.provide(signIn),
    Layer.provide(Webhook.layer()),
    Layer.provide([
      Testing.layer(receiver),
      Dns.layerStatic({ hosts: { "hooks.example.com": ["93.184.216.34"] } }),
    ])
  );

  const entities = ActionEntity.layer(Ticker, ticking).pipe(
    Layer.provideMerge(failingPolls(fails)),
    Layer.provide([signIn, Event.layerMemory])
  );

  return {
    counted,
    ticks,
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

describe("ActionEntity.reaching's events by webhook", () => {
  it.live(
    "offers no webhook delivery, and refuses a webhook subscription over MCP and HTTP before any callback or entity is reached",
    () => {
      const { counted, server } = makeTicker();

      return Effect.gen(function* () {
        const listed = yield* mcpSent("events/list", {});

        const overMcp = yield* mcpSent("events/subscribe", {
          name: "ticked",
          arguments: { room: "a" },
          delivery: { mode: "webhook", ...delivery },
        });

        const overHttp = yield* HttpClient.execute(
          HttpClientRequest.post("/api/events/ticked/subscribe").pipe(
            HttpClientRequest.setHeaders(asAlice.headers),
            HttpClientRequest.bodyJsonUnsafe({ input: { room: "a" }, delivery })
          )
        );

        expect(listed).toMatchObject({
          result: { events: [{ name: "ticked", delivery: ["poll"] }] },
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
      }).pipe(Effect.scoped, Effect.provide(server));
    }
  );
});

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

describe("ActionEntity.reaching's event streams", () => {
  it.live(
    "ask the entity again after a transient cluster failure, from where the stream reached, in the same stream",
    () => {
      const { counted, ticks, server } = makeTicker((call) => call === 2);

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
