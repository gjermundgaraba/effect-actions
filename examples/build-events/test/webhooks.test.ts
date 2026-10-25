import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Queue, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Http } from "../src/Api.js";
import { routes } from "../src/routes.js";
import { inMemory } from "./support/memory.js";

// The subscriber's secret: `whsec_` and 24 to 64 random bytes in base64. The server signs each
// POST with it, and the subscriber checks each POST it receives against it.
const secret = `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")}`;

// A subscriber's check, as Standard Webhooks defines it: an HMAC-SHA256 of the id, the
// timestamp and the body exactly as received, among the space-separated `v1,` signatures.
const signed = async (request: Request, body: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(secret.slice("whsec_".length), "base64"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signedContent = [
    request.headers.get("webhook-id"),
    request.headers.get("webhook-timestamp"),
    body,
  ].join(".");

  const expected = Buffer.from(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent)),
  ).toString("base64");

  return (request.headers.get("webhook-signature") ?? "").split(" ").includes(`v1,${expected}`);
};

const Delivered = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));

interface Received {
  readonly body: typeof Delivered.Type;
  readonly signed: boolean;
}

// grace's server: it answers the verification POST by echoing its challenge, which proves it
// asked for these deliveries, and acknowledges each delivery with a 2xx.
const subscriber = (received: Queue.Enqueue<Received>) => async (request: Request) => {
  const text = await request.text();
  const body = Schema.decodeUnknownSync(Delivered)(text);

  Queue.offerUnsafe(received, { body, signed: await signed(request, text) });

  return body["type"] === "verification"
    ? Response.json({ challenge: body["challenge"] })
    : new Response(null);
};

const served = (received: Queue.Enqueue<Received>) =>
  Testing.layer(routes).pipe(Layer.provide(inMemory(Testing.layer(subscriber(received)))));

const Subscribed = Schema.Struct({
  id: Schema.String,
  refreshBefore: Schema.NullOr(Schema.String),
  deliveryStatus: Schema.optional(
    Schema.Struct({ active: Schema.Boolean, lastError: Schema.NullOr(Schema.String) }),
  ),
});

const subscribe = Effect.flatMap(HttpClient.HttpClient, (client) =>
  client.execute(
    HttpClientRequest.post("/api/events/build.finished/subscribe").pipe(
      HttpClientRequest.bearerToken("grace"),
      HttpClientRequest.bodyJsonUnsafe({
        input: { status: "passed" },
        delivery: { url: "https://hooks.example.com/grace", secret },
      }),
    ),
  ),
).pipe(
  Effect.flatMap((response) => response.json),
  Effect.flatMap(Schema.decodeUnknownEffect(Subscribed)),
);

describe("the service, by webhook", () => {
  it.effect("POSTs each build a member may see to its callback, signed", () =>
    Effect.flatMap(Queue.unbounded<Received>(), (received) =>
      Effect.gen(function* () {
        const ada = yield* ActionHttp.client(Http, {
          transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken("ada")),
        });

        // The answer names the subscription, which each POST's `x-mcp-subscription-id`
        // carries, and when to subscribe again to keep it: one not refreshed by then ends.
        const subscription = yield* subscribe;
        const verification = yield* Queue.take(received);

        yield* ada.finishBuild({ pipeline: "api", status: "passed" });
        // Each build finished notifies `build.finished`: the server asks the store at once, and
        // POSTs what it answers.
        yield* ada.finishBuild({ pipeline: "web", status: "passed" });

        // grace sees only the web pipeline.
        const delivery = yield* Queue.take(received);

        // The same request again refreshes the subscription, and answers how it is going.
        const refreshed = yield* subscribe;

        expect(verification).toMatchObject({ body: { type: "verification" }, signed: true });
        expect(delivery).toMatchObject({
          body: { name: "build.finished", data: { id: "build-2", pipeline: "web" } },
          signed: true,
        });
        expect(refreshed).toMatchObject({
          id: subscription.id,
          deliveryStatus: { active: true, lastError: null },
        });
      }).pipe(Effect.provide(served(received))),
    ),
  );
});
