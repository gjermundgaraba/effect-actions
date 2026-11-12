import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { TestRunner } from "effect/cluster";
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

const makeTicker = () => {
  const counted = { checks: 0, callbacks: 0 };

  const ticking = Event.implement(
    Ticked,
    {
      check: () =>
        Effect.sync(() => {
          counted.checks += 1;

          return { cursor: "0", events: [] };
        }),
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
    Layer.provideMerge(TestRunner.layer),
    Layer.provide([signIn, Event.layerMemory])
  );

  return {
    counted,
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
        expect(counted).toStrictEqual({ checks: 0, callbacks: 0 });
      }).pipe(Effect.scoped, Effect.provide(server));
    }
  );
});
