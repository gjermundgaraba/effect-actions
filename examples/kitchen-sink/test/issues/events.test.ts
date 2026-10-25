import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Queue, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { RateLimiter } from "effect/persistence";
import { TestClock } from "effect/testing";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { members } from "../../src/identity/members.js";
import { issueEvents } from "../../src/issues/events.js";
import { issues } from "../../src/issues/handlers.js";
import { IssueChanged } from "../../src/issues/Issues.js";
import { IssueStore } from "../../src/issues/store.js";
import { publicRoutes } from "../../src/routes.js";
import { as } from "../support/as.js";
import { services } from "../support/services.js";

const inProcess = Layer.mergeAll(
  IssueStore.layerMemory,
  RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory)),
  Event.layerMemory,
);

// The changes a member's watch receives, as data, while `act` changes issues.
const watched = <E, R>(
  member: keyof typeof members,
  input: typeof IssueChanged.input.Type,
  count: number,
  act: (client: Action.Client<[typeof issues, typeof issueEvents]>) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    const client = yield* Action.client([issues, issueEvents]);

    const watching = yield* client.watch(IssueChanged, input).pipe(
      Stream.filter((received) => received._tag === "Occurrence"),
      Stream.map((occurrence) => occurrence.data),
      Stream.take(count),
      Stream.runCollect,
      as(member),
      Effect.forkChild,
    );

    // Lets the forked watch run up to its subscription first: started after `act`, it would wait
    // for changes already made.
    yield* TestClock.adjust("0 millis");
    yield* act(client);

    return yield* Fiber.join(watching);
  });

describe("issue.changed", () => {
  it.effect("gives a member the changes of their own workspace alone, as they happen", () =>
    Effect.gen(function* () {
      const changes = yield* watched("linus", {}, 2, (client) =>
        Effect.gen(function* () {
          const filed = yield* client.createIssue({ title: "Crash", body: "" }).pipe(as("ada"));

          yield* client.createIssue({ title: "Elsewhere", body: "" }).pipe(as("grace"));
          yield* client.commentOnIssue({ id: filed.id, text: "Seen it." }).pipe(as("ada"));
        }),
      );

      expect(changes).toEqual([
        { workspace: "acme", id: "ACME-1", title: "Crash", status: "open", change: "filed" },
        {
          workspace: "acme",
          id: "ACME-1",
          title: "Crash",
          status: "open",
          change: "commented",
          comment: { author: "ada", text: "Seen it." },
        },
      ]);
    }).pipe(Effect.provide(inProcess)),
  );

  it.effect("filters by status and leaves the comment out where asked", () =>
    Effect.gen(function* () {
      const changes = yield* watched("linus", { status: "closed", comments: false }, 2, (client) =>
        Effect.gen(function* () {
          const filed = yield* client.createIssue({ title: "Crash", body: "" }).pipe(as("ada"));

          yield* client.commentOnIssue({ id: filed.id, text: "Seen it." }).pipe(as("ada"));
          yield* client.closeIssue({ id: filed.id }).pipe(as("ada"));
          // Closing it again changes nothing, and nothing is sent.
          yield* client.closeIssue({ id: filed.id }).pipe(as("ada"));
          yield* client.commentOnIssue({ id: filed.id, text: "Fixed." }).pipe(as("ada"));
        }),
      );

      expect(changes).toEqual([
        { workspace: "acme", id: "ACME-1", title: "Crash", status: "closed", change: "closed" },
        { workspace: "acme", id: "ACME-1", title: "Crash", status: "closed", change: "commented" },
      ]);
    }).pipe(Effect.provide(inProcess)),
  );

  it.effect("refuses a member without the read scope", () =>
    Effect.gen(function* () {
      const client = yield* Action.client([issues, issueEvents]);

      expect(
        yield* Effect.flip(Stream.runDrain(client.watch(IssueChanged)).pipe(as("kay"))),
      ).toEqual(
        new Action.Forbidden({ message: "Requires issues:read.", scopes: ["issues:read"] }),
      );
    }).pipe(Effect.provide(inProcess)),
  );
});

// The subscriber's secret: `whsec_` and 24 to 64 random bytes in base64.
const secret = `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")}`;

const Delivered = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));

// linus's server: it echoes the verification's challenge, which proves it asked for these
// deliveries, and acknowledges each delivery with a 2xx.
const subscriber = (received: Queue.Enqueue<typeof Delivered.Type>) => async (request: Request) => {
  const body = Schema.decodeUnknownSync(Delivered)(await request.text());

  Queue.offerUnsafe(received, body);

  return body["type"] === "verification"
    ? Response.json({ challenge: body["challenge"] })
    : new Response(null);
};

const signedIn = (token: string, workspace: string) =>
  HttpClient.mapRequest((request) =>
    request.pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setHeader("x-workspace", workspace),
    ),
  );

describe("issue.changed by webhook", () => {
  it.effect("POSTs each change of the subscriber's workspace, as the subscriber sees it", () =>
    Effect.flatMap(Queue.unbounded<typeof Delivered.Type>(), (received) =>
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient;

        yield* http.pipe(signedIn("linus", "acme")).execute(
          HttpClientRequest.post("/api/v1/events/issue.changed/subscribe").pipe(
            HttpClientRequest.bodyJsonUnsafe({
              input: { comments: false },
              delivery: { url: "https://hooks.example.com/linus", secret },
            }),
          ),
        );

        const verification = yield* Queue.take(received);

        for (const [token, workspace, url, body] of [
          ["grace", "globex", "/api/v1/createIssue", { title: "From grace", body: "" }],
          ["ada", "acme", "/api/v1/createIssue", { title: "From ada", body: "" }],
          ["ada", "acme", "/api/v1/commentOnIssue", { id: "ACME-1", text: "Seen it." }],
        ] as const) {
          yield* http
            .pipe(signedIn(token, workspace))
            .execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body)));
        }

        const deliveries = [yield* Queue.take(received), yield* Queue.take(received)];

        expect(verification).toMatchObject({ type: "verification" });
        expect(deliveries.map(({ name, data }) => ({ name, data }))).toEqual([
          {
            name: "issue.changed",
            data: {
              workspace: "acme",
              id: "ACME-1",
              title: "From ada",
              status: "open",
              change: "filed",
            },
          },
          {
            name: "issue.changed",
            data: {
              workspace: "acme",
              id: "ACME-1",
              title: "From ada",
              status: "open",
              change: "commented",
            },
          },
        ]);
      }).pipe(
        Effect.provide(
          Testing.layer(publicRoutes).pipe(
            Layer.provide(services(Testing.layer(subscriber(received)))),
          ),
        ),
      ),
    ),
  );
});
