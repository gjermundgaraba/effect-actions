import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Dns } from "effect/net";
import * as Authentication from "../../src/authentication/Authentication.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as Testing from "../../src/testing/Testing.js";
import * as Webhook from "../../src/webhook/Webhook.js";
import { verify } from "../support/app/authentication.js";
import { CurrentActor } from "../support/app/authorization.js";

const Changed = Event.make("user.changed", {
  description: "A user changed.",
  payload: { by: Schema.String },
  caller: CurrentActor,
});

const Login = Authentication.make("webhook-mcp.Login", CurrentActor, {
  principal: (actor) => actor.id,
});

const Http = ActionHttp.make([Changed], { authentication: Login });

const changed = Event.implement(
  Changed,
  { check: () => Effect.succeed({ cursor: "0", events: [] }) },
  { authorize: Event.allowAll },
);

const Json = Schema.fromJsonString(Schema.Json);

const secret = `whsec_${Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString("base64")}`;

const url = "https://hooks.example.com/alice";

const makeServer = (webhooks: boolean, echoes = true, requestScoped = false) => {
  const received: Array<string> = [];

  const receiver = async (request: Request) => {
    const body = await request.text();

    received.push(body);

    const challenge = /"challenge":"([^"]+)"/u.exec(body)?.[1];

    return echoes && challenge !== undefined
      ? Response.json({ challenge })
      : new Response(null, { status: 200 });
  };

  const routes = Layer.mergeAll(
    ActionMcp.layerHttp(changed, {
      name: "webhooks",
      version: "1.0.0",
      authentication: Login,
      requestScoped,
    }),
    ActionHttp.layer(Http, changed),
  ).pipe(Layer.provide(Authentication.layer(Login, verify)), Layer.provide(Event.layerMemory));

  const served = webhooks
    ? routes.pipe(
        Layer.provide(Webhook.layer()),
        Layer.provide([
          Testing.layer(receiver),
          Dns.layerStatic({ hosts: { "hooks.example.com": ["93.184.216.34"] } }),
        ]),
      )
    : routes;

  return { received, server: Testing.layer(served) };
};

const send = (method: string, params: ActionMcp.Params) =>
  Effect.flatMap(
    HttpClient.execute(
      ActionMcp.request(method, params, { headers: { authorization: "Bearer alice" } }),
    ),
    (response) => Effect.map(response.text, (body) => Schema.decodeUnknownSync(Json)(body)),
  );

const subscribe = (subscriptionSecret = secret) =>
  send("events/subscribe", {
    name: "user.changed",
    arguments: {},
    delivery: { mode: "webhook", url, secret: subscriptionSecret },
  });

describe("webhook delivery over MCP", () => {
  it.effect(
    "lists webhook for a protected event where Webhook.layer is provided, request-scoped too",
    () =>
      Effect.gen(function* () {
        const listed = (webhooks: boolean, requestScoped = false) =>
          send("events/list", {}).pipe(
            Effect.provide(makeServer(webhooks, true, requestScoped).server),
          );

        expect(yield* listed(true)).toMatchObject({
          result: { events: [{ name: "user.changed", delivery: ["poll", "push", "webhook"] }] },
        });
        expect(yield* listed(false)).toMatchObject({
          result: { events: [{ name: "user.changed", delivery: ["poll", "push"] }] },
        });
        expect(yield* listed(true, true)).toMatchObject({
          result: { events: [{ name: "user.changed", delivery: ["poll", "webhook"] }] },
        });
      }),
  );

  it.effect("holds one subscription for MCP and HTTP alike, verifying its callback once", () => {
    const { received, server } = makeServer(true);

    return Effect.gen(function* () {
      const overMcp = yield* subscribe();

      const overHttp = yield* Effect.flatMap(HttpClient.HttpClient, (client) =>
        client.execute(
          HttpClientRequest.post("http://localhost/api/events/user.changed/subscribe").pipe(
            HttpClientRequest.bearerToken("alice"),
            HttpClientRequest.bodyJsonUnsafe({ input: {}, delivery: { url, secret } }),
          ),
        ),
      ).pipe(Effect.flatMap((response) => response.json));

      expect(overMcp).toMatchObject({ result: { resultType: "complete", truncated: false } });
      expect(overHttp).toMatchObject({
        id: Schema.decodeUnknownSync(
          Schema.Struct({ result: Schema.Struct({ id: Schema.String }) }),
        )(overMcp).result.id,
        deliveryStatus: { active: true },
      });
      expect(received.filter((body) => body.includes('"verification"'))).toHaveLength(1);
    }).pipe(Effect.provide(server));
  });

  it.effect("answers what a webhook's request got wrong in SEP-3415's codes", () =>
    Effect.gen(function* () {
      const [weak, unknown, unverified, unserved, unnamed] = yield* Effect.all([
        subscribe("whsec_c2hvcnQ=").pipe(Effect.provide(makeServer(true).server)),
        send("events/unsubscribe", {
          name: "user.changed",
          arguments: {},
          delivery: { url },
        }).pipe(Effect.provide(makeServer(true).server)),
        subscribe().pipe(Effect.provide(makeServer(true, false).server)),
        subscribe().pipe(Effect.provide(makeServer(false).server)),
        send("events/subscribe", {
          name: "user.renamed",
          arguments: {},
          delivery: { mode: "webhook", url, secret },
        }).pipe(Effect.provide(makeServer(true).server)),
      ]);

      expect(weak).toMatchObject({ error: { code: -32602 } });
      expect(unknown).toMatchObject({ error: { code: -32023, data: { kind: "subscription" } } });
      expect(unverified).toMatchObject({
        error: { code: -32027, data: { reason: "challenge_failed" } },
      });
      expect(unserved).toMatchObject({
        error: { code: -32026, data: { feature: "deliveryMode", value: "webhook" } },
      });
      expect(unnamed).toMatchObject({ error: { code: -32023, data: { kind: "event" } } });
    }),
  );
});
