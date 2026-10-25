import { describe, expect, it, vi } from "@effect/vitest";
import {
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  ErrorReporter,
  Exit,
  Fiber,
  Layer,
  Queue,
  Schema,
  Scope,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Dns } from "effect/net";
import { TestClock } from "effect/testing";
import * as Authentication from "../../src/authentication/Authentication.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as Testing from "../../src/testing/Testing.js";
import * as Webhook from "../../src/webhook/Webhook.js";
import { verify } from "../support/app/authentication.js";
import { actors, CurrentActor } from "../support/app/authorization.js";
import { recorder } from "../support/reporter.js";
import {
  acknowledging,
  bodyOf,
  events,
  makeWorld,
  secretOf,
  sent,
  signedBy,
  subscribed,
  turn,
  until,
  url,
} from "../support/webhook.js";

describe("webhook delivery over HTTP", () => {
  it.effect(
    "verifies the callback, then POSTs each occurrence signed, under the subscription's id",
    () => {
      const { world, server } = makeWorld();
      const secret = secretOf(1);

      return Effect.gen(function* () {
        const grant = yield* subscribed(secret);

        world.changes.push({ id: "c1", by: "bob" });

        yield* until(() => world.received.length >= 2);

        const [verification, delivery] = world.received;

        expect(grant).toMatchObject({ cursor: "0", truncated: false });
        expect(verification && bodyOf(verification)).toMatchObject({ type: "verification" });
        expect(delivery && bodyOf(delivery)).toMatchObject({
          eventId: "c1",
          name: "user.changed",
          data: { id: "c1", by: "bob" },
          cursor: "1",
        });
        expect(delivery).toMatchObject({
          id: "c1",
          subscription: grant.id,
          redirect: "manual",
          keepalive: true,
          traceparent: null,
        });
        expect(
          yield* Effect.promise(() =>
            Promise.all(world.received.map((each) => signedBy(secret, each))),
          ),
        ).toEqual([true, true]);
      }).pipe(Effect.provide(server));
    },
  );

  it.effect("refuses a callback that is not https, or a secret that is not whsec_", () =>
    Effect.gen(function* () {
      const [plain, weak] = yield* Effect.all([
        sent("alice", "subscribe", {
          input: {},
          delivery: { url: "http://hooks.example.com/alice", secret: secretOf(1) },
        }),
        sent("alice", "subscribe", { input: {}, delivery: { url, secret: "whsec_c2hvcnQ=" } }),
      ]);

      expect([plain.status, weak.status]).toEqual([400, 400]);
    }).pipe(Effect.provide(makeWorld().server)),
  );

  it.effect("never POSTs to a callback resolving to an address not globally reachable", () => {
    const { world, server } = makeWorld();

    return Effect.gen(function* () {
      const refused = yield* Effect.forEach(
        ["https://127.0.0.1/a", "https://[::ffff:10.0.0.1]/a", "https://100.64.0.1/a"],
        (callback) =>
          Effect.flatMap(
            sent("alice", "subscribe", {
              input: {},
              delivery: { url: callback, secret: secretOf(1) },
            }),
            (response) => Effect.map(response.json, (body) => [response.status, body] as const),
          ),
      );

      for (const [status, body] of refused) {
        expect(status).toBe(409);
        expect(body).toMatchObject({
          _tag: "SubscriptionError",
          reason: { _tag: "CallbackFailed", category: "connection_refused" },
        });
      }

      expect(world.received).toEqual([]);
    }).pipe(Effect.provide(server));
  });

  it.effect(
    "with resolveCallbacks false, checks a literal address alone, leaving a name to the platform",
    () => {
      const trusting = makeWorld({ resolveCallbacks: false });
      const resolving = makeWorld();

      const statusOf = (callback: string) =>
        Effect.map(
          sent("alice", "subscribe", {
            input: {},
            delivery: { url: callback, secret: secretOf(1) },
          }),
          ({ status }) => status,
        );

      return Effect.gen(function* () {
        const trusted = yield* Effect.all([
          statusOf("https://127.0.0.1/a"),
          statusOf("https://unlisted.example/a"),
        ]).pipe(Effect.provide(trusting.server));

        const resolved = yield* statusOf("https://unlisted.example/a").pipe(
          Effect.provide(resolving.server),
        );

        expect(trusted).toEqual([409, 200]);
        expect(resolved).toBe(409);
        expect(trusting.world.received.map(({ body }) => body)).toEqual([
          expect.stringContaining('"verification"'),
        ]);
      });
    },
  );

  it.effect("refuses a callback that does not echo its challenge, and skips one it trusts", () => {
    const refusing = makeWorld();
    const trusting = makeWorld({ allowedCallbacks: ["https://hooks.example.com/"] });

    refusing.world.answer = () => new Response(null, { status: 200 });

    return Effect.gen(function* () {
      const response = yield* sent("alice", "subscribe", {
        input: {},
        delivery: { url, secret: secretOf(1) },
      }).pipe(Effect.provide(refusing.server));

      yield* subscribed().pipe(Effect.provide(trusting.server));

      expect(yield* response.json).toMatchObject({
        reason: { _tag: "CallbackFailed", category: "challenge_failed" },
      });
      expect(trusting.world.received).toEqual([]);
    });
  });

  it.effect("unsubscribes, after which nothing more is POSTed", () => {
    const { world, server } = makeWorld();
    const subscription = { input: {}, delivery: { url } };

    return Effect.gen(function* () {
      yield* subscribed();

      const gone = yield* sent("alice", "unsubscribe", subscription);
      const again = yield* sent("alice", "unsubscribe", subscription);

      world.changes.push({ id: "c1", by: "bob" });

      yield* until(() => false);

      expect([gone.status, again.status]).toEqual([204, 409]);
      expect(events(world.received)).toEqual([]);
    }).pipe(Effect.provide(server));
  });

  it.effect("refuses a subscribe signed out, as the route's 401", () =>
    Effect.gen(function* () {
      const response = yield* Effect.flatMap(HttpClient.HttpClient, (client) =>
        client.execute(
          HttpClientRequest.post("http://localhost/api/events/user.changed/subscribe").pipe(
            HttpClientRequest.bodyJsonUnsafe({ input: {}, delivery: { url, secret: secretOf(1) } }),
          ),
        ),
      );

      expect(response.status).toBe(401);
    }).pipe(Effect.provide(makeWorld().server)),
  );

  it.effect(
    "retries a failed delivery, backing off, and resumes from no later than what was acknowledged, past a heartbeat",
    () => {
      const { world, server } = makeWorld();

      return Effect.gen(function* () {
        yield* subscribed();

        world.changes.push({ id: "c1", by: "bob" });

        yield* until(() => events(world.received).length >= 1);

        world.answer = (body) =>
          body["type"] === undefined ? new Response(null, { status: 503 }) : acknowledging(body);

        const posted = yield* Clock.currentTimeMillis;

        world.changes.push({ id: "c2", by: "bob" });

        yield* until(() => events(world.received).length >= 2);

        const observed = yield* Clock.currentTimeMillis;

        yield* until(() => events(world.received).length >= 3);
        yield* TestClock.adjust("1 minute");

        const failing = yield* subscribed();
        const attempted = events(world.received).length;

        world.answer = acknowledging;

        yield* until(() => events(world.received).length > attempted);

        const recovered = yield* subscribed();

        expect(failing).toMatchObject({
          cursor: "1",
          deliveryStatus: { active: true, lastError: "http_5xx" },
        });
        expect(Date.parse(failing.deliveryStatus?.failedSince ?? "")).toBeGreaterThanOrEqual(
          posted,
        );
        expect(Date.parse(failing.deliveryStatus?.failedSince ?? "")).toBeLessThanOrEqual(observed);
        expect(recovered).toMatchObject({
          cursor: "2",
          deliveryStatus: { active: true, lastError: null },
        });
        expect(recovered.deliveryStatus).not.toHaveProperty("failedSince");
        expect(
          events(world.received)
            .map(({ eventId }) => eventId)
            .slice(1),
        ).toEqual(Array.from({ length: attempted }, () => "c2"));
      }).pipe(Effect.provide(server));
    },
  );

  it.effect(
    "suspends at a delivery retried for retryFor, which a refresh delivers again before the next",
    () => {
      const { world, server } = makeWorld({ retryFor: "10 seconds" });

      return Effect.gen(function* () {
        yield* subscribed();

        world.answer = (body) =>
          body["type"] === undefined ? new Response(null, { status: 500 }) : acknowledging(body);
        world.changes.push({ id: "c1", by: "bob" });

        yield* until(() => false);

        const attempts = events(world.received).length;

        world.changes.push({ id: "c2", by: "bob" });

        yield* TestClock.adjust("30 minutes");

        const suspended = yield* subscribed();

        world.answer = acknowledging;

        yield* until(() => events(world.received).some(({ eventId }) => eventId === "c2"));

        expect(attempts).toBeGreaterThan(1);
        expect(suspended.deliveryStatus).toMatchObject({ active: false, lastError: "http_5xx" });
        expect(events(world.received).map(({ eventId }) => eventId)).toEqual([
          ...Array.from({ length: attempts }, () => "c1"),
          "c1",
          "c2",
        ]);
      }).pipe(Effect.provide(server));
    },
  );

  it.effect(
    "times a failing delivery from its own first failure, not from one abandoned at a 410 before",
    () => {
      const { world, server } = makeWorld({ retryFor: "1 minute", maxTtl: "3 hours" });

      return Effect.gen(function* () {
        yield* subscribed(secretOf(1), 3 * 60 * 60 * 1000);

        world.answer = (body) =>
          body["type"] === "verification"
            ? acknowledging(body)
            : new Response(null, { status: 410 });
        world.changes.push({ id: "c1", by: "bob" });

        yield* until(() => false);
        yield* TestClock.adjust("2 hours");

        world.answer = (body) =>
          body["type"] === undefined ? new Response(null, { status: 500 }) : acknowledging(body);
        world.changes.push({ id: "c2", by: "bob" });

        yield* until(() => false);

        const retried = events(world.received).filter(({ eventId }) => eventId === "c2").length;

        expect(retried).toBeGreaterThan(2);
      }).pipe(Effect.provide(server));
    },
  );

  it.effect("retries a suspended subscription its refresh resumes for a fresh retryFor", () => {
    const { world, server } = makeWorld({ retryFor: "10 seconds" });

    return Effect.gen(function* () {
      yield* subscribed();

      world.answer = (body) =>
        body["type"] === undefined ? new Response(null, { status: 500 }) : acknowledging(body);
      world.changes.push({ id: "c1", by: "bob" });

      yield* until(() => false);

      const suspendedAt = events(world.received).length;

      yield* subscribed();
      yield* until(() => events(world.received).length > suspendedAt + 1);

      const resumed = yield* subscribed();

      expect(resumed.deliveryStatus).toMatchObject({ active: true, lastError: "http_5xx" });
      expect(events(world.received).length).toBeGreaterThan(suspendedAt + 1);
    }).pipe(Effect.provide(server));
  });

  it.effect("retries a failing delivery for an hour by default, at most 5 minutes apart", () => {
    const { world, server } = makeWorld({ maxTtl: "3 hours" });

    return Effect.gen(function* () {
      yield* subscribed(secretOf(1), 3 * 60 * 60 * 1000);

      let signed = 0;
      const sign = crypto.subtle.sign.bind(crypto.subtle);

      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(crypto.subtle, "sign").mockImplementation((...args) => {
            signed += 1;

            return sign(...args);
          }),
        ),
        (spied) => Effect.sync(() => spied.mockRestore()),
      );

      world.answered = 0;

      const attempted = Effect.andThen(
        Effect.repeat(turn, { until: () => world.answered >= signed }),
        turn,
      );

      world.answer = (body) =>
        body["type"] === undefined ? new Response(null, { status: 500 }) : acknowledging(body);
      world.changes.push({ id: "c1", by: "bob" });

      yield* Effect.repeat(Effect.andThen(TestClock.adjust("5 seconds"), attempted), {
        times: (2 * 60 * 60) / 5,
      });

      const sentAt = world.received
        .filter((delivery) => bodyOf(delivery)["eventId"] === "c1")
        .map(({ timestamp }) => Number(timestamp));

      const apart = sentAt.slice(1).map((at, index) => at - (sentAt[index] ?? at));
      const span = (sentAt.at(-1) ?? 0) - (sentAt[0] ?? 0);

      expect(Math.max(...apart)).toBeGreaterThanOrEqual(300);
      expect(Math.max(...apart)).toBeLessThan(330);
      expect(span).toBeGreaterThan(3600);
      expect(span).toBeLessThan(3600 + 330);
    }).pipe(Effect.scoped, Effect.provide(server));
  });

  it.effect(
    "abandons a delivery its callback answers 410 or 413, leaving a gap in its place",
    () => {
      const { world, server } = makeWorld();

      return Effect.gen(function* () {
        yield* subscribed();

        const abandoning = new Map<Schema.Json | undefined, number>([
          ["gone", 410],
          ["large", 413],
        ]);

        world.answer = (body) => {
          const status = abandoning.get(body["eventId"]);

          return status === undefined ? acknowledging(body) : new Response(null, { status });
        };

        world.changes.push(
          { id: "gone", by: "bob" },
          { id: "large", by: "bob" },
          { id: "kept", by: "bob" },
        );

        yield* until(() => events(world.received).some(({ eventId }) => eventId === "kept"));
        yield* until(() => false);

        expect(
          world.received
            .map(bodyOf)
            .filter(({ type }) => type !== "verification")
            .map(({ type, eventId, cursor }) => [type ?? eventId, cursor]),
        ).toEqual([
          ["gone", "0"],
          ["gap", "0"],
          ["large", "0"],
          ["gap", "0"],
          ["kept", "3"],
        ]);
      }).pipe(Effect.provide(server));
    },
  );

  it.effect("signs with the old secret beside the new one for a while after a rotation", () => {
    const { world, server } = makeWorld();
    const [first, second] = [secretOf(1), secretOf(2)];

    return Effect.gen(function* () {
      yield* subscribed(first);
      yield* subscribed(second);

      world.changes.push({ id: "c1", by: "bob" });

      yield* until(() => events(world.received).length >= 1);
      yield* TestClock.adjust("10 minutes");

      world.changes.push({ id: "c2", by: "bob" });

      yield* until(() => events(world.received).length >= 2);

      const [rotated, settled] = world.received.filter(
        (delivery) => bodyOf(delivery)["type"] === undefined,
      );

      expect(
        yield* Effect.promise(() =>
          Promise.all(
            [rotated, settled].flatMap((delivery) =>
              delivery === undefined ? [] : [signedBy(first, delivery), signedBy(second, delivery)],
            ),
          ),
        ),
      ).toEqual([true, true, false, true]);
    }).pipe(Effect.provide(server));
  });

  it.effect(
    "grants a lifetime clamped between 1 minute and maxTtl, and ends the subscription when it lapses",
    () => {
      const { world, server } = makeWorld({ maxTtl: "1 hour" });

      return Effect.gen(function* () {
        const start = yield* Clock.currentTimeMillis;

        const grants = yield* Effect.forEach([1_000, 10 * 60 * 60 * 1000, null], (ttlMs) =>
          Effect.map(subscribed(secretOf(1), ttlMs), ({ refreshBefore }) =>
            refreshBefore === null ? null : Date.parse(refreshBefore) - start,
          ),
        );

        yield* TestClock.adjust("61 minutes");

        world.changes.push({ id: "c1", by: "bob" });

        yield* until(() => false);

        expect(grants).toEqual([60_000, 3_600_000, 3_600_000]);
        expect(events(world.received)).toEqual([]);
      }).pipe(Effect.provide(server));
    },
  );

  it.effect("grants at most 1 hour where maxTtl is not given", () => {
    const { server } = makeWorld();

    return Effect.gen(function* () {
      const start = yield* Clock.currentTimeMillis;
      const { refreshBefore } = yield* subscribed(secretOf(1), 10 * 60 * 60 * 1000);

      expect(refreshBefore === null ? null : Date.parse(refreshBefore) - start).toBe(3_600_000);
    }).pipe(Effect.provide(server));
  });

  it.effect(
    "ends the subscription with a signed terminated envelope when its subscriber is refused later",
    () => {
      const { world, server } = makeWorld();

      return Effect.gen(function* () {
        yield* subscribed();

        world.revoked.add("alice");
        world.changes.push({ id: "c1", by: "bob" });

        yield* until(() => world.received.length >= 2);

        const gone = yield* sent("alice", "unsubscribe", { input: {}, delivery: { url } });

        expect(world.received.map(bodyOf).at(-1)).toMatchObject({
          type: "terminated",
          error: { code: -32024, message: "Revoked.", data: { _tag: "Forbidden" } },
        });
        expect(world.received.at(-1)?.id).toMatch(/^msg_terminated_/u);
        expect(gone.status).toBe(409);
      }).pipe(Effect.provide(server));
    },
  );

  it.effect("ends delivery at a refresh's shorter grant, after which it is not subscribed", () => {
    const { world, server } = makeWorld({ maxTtl: "1 hour" });

    return Effect.gen(function* () {
      yield* subscribed(secretOf(1), null);
      yield* subscribed(secretOf(1), 60_000);
      yield* TestClock.adjust("5 minutes");

      const gone = yield* sent("alice", "unsubscribe", { input: {}, delivery: { url } });

      world.changes.push({ id: "c1", by: "bob" });

      yield* until(() => false);

      expect(gone.status).toBe(409);
      expect(events(world.received)).toEqual([]);
    }).pipe(Effect.provide(server));
  });

  it.effect("tries a terminated envelope its callback fails four times, then gives it up", () => {
    const { world, server } = makeWorld();

    return Effect.gen(function* () {
      yield* subscribed();

      world.answer = (body) =>
        body["type"] === "terminated" ? new Response(null, { status: 500 }) : acknowledging(body);
      world.revoked.add("alice");
      world.changes.push({ id: "c1", by: "bob" });

      yield* until(() => false);
      yield* TestClock.adjust("1 hour");

      expect(world.received.map(bodyOf).filter(({ type }) => type === "terminated")).toHaveLength(
        4,
      );
    }).pipe(Effect.provide(server));
  });

  it.effect("closes while a terminated envelope is failing", () => {
    const { world, server } = makeWorld();

    return Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(server, scope);

      yield* subscribed().pipe(Effect.provideContext(context));

      world.answer = (body) =>
        body["type"] === "terminated" ? new Response(null, { status: 500 }) : acknowledging(body);
      world.revoked.add("alice");
      world.changes.push({ id: "c1", by: "bob" });

      yield* until(() => world.received.some((each) => bodyOf(each)["type"] === "terminated"));

      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));

      yield* TestClock.adjust("1 second");

      expect(yield* Fiber.join(closing)).toBeUndefined();
    });
  });

  it.effect("trusts an allowedCallbacks entry's origin exactly and its path by segment", () => {
    const { world, server } = makeWorld({ allowedCallbacks: ["https://hooks.example.com/alice"] });

    world.answer = () => new Response(null, { status: 200 });

    return Effect.gen(function* () {
      const statuses = yield* Effect.forEach(
        [
          "https://hooks.example.com/alice",
          "https://hooks.example.com/alice/builds",
          "https://hooks.example.com/alicebob",
          "https://hooks.example.com.evil.net/alice",
        ],
        (callback) =>
          Effect.map(
            sent("alice", "subscribe", {
              input: {},
              delivery: { url: callback, secret: secretOf(1) },
            }),
            ({ status }) => status,
          ),
      );

      expect(statuses).toEqual([200, 200, 409, 409]);
      expect(world.received.map(bodyOf)).toMatchObject([
        { type: "verification" },
        { type: "verification" },
      ]);
    }).pipe(Effect.provide(server));
  });

  it("refuses an allowedCallbacks entry that is not an https URL when the layer is made", () => {
    expect(() => Webhook.layer({ allowedCallbacks: ["hooks.example.com"] })).toThrow(
      "Invalid allowedCallbacks entry: hooks.example.com (give an https URL, such as https://hooks.example.com/)",
    );
  });

  it("refuses a maxTtl of no end when the layer is made, as every grant expires", () => {
    expect(() => Webhook.layer({ maxTtl: Duration.infinity })).toThrow(
      new Error(
        'Invalid maxTtl: Infinity (every grant expires: give a finite duration, such as "1 hour")',
      ),
    );
  });

  it.effect(
    "POSTs a gap at the cursor of an occurrence too large to deliver, then the next",
    () => {
      const { world, server } = makeWorld();

      return Effect.gen(function* () {
        yield* subscribed();

        world.changes.push({ id: "large", by: "x".repeat(300 * 1024) });

        yield* until(() => world.received.length >= 2);

        world.changes.push({ id: "kept", by: "bob" });

        yield* until(() => events(world.received).length >= 1);

        expect(world.received.slice(1).map(bodyOf)).toMatchObject([
          { type: "gap", cursor: "1" },
          { eventId: "kept", cursor: "2" },
        ]);
      }).pipe(Effect.provide(server));
    },
  );

  it.effect("verifies one callback for each principal subscribing to it", () => {
    const { world, server } = makeWorld();

    return Effect.gen(function* () {
      yield* subscribed(secretOf(1), undefined, { token: "alice" });
      yield* subscribed(secretOf(2), undefined, { token: "bob" });
      yield* subscribed(secretOf(1), undefined, { token: "alice" });

      expect(world.received.map(bodyOf).filter(({ type }) => type === "verification")).toHaveLength(
        2,
      );
    }).pipe(Effect.provide(server));
  });

  it.effect("delivers a log source's occurrences, from its subscription on", () =>
    Effect.gen(function* () {
      const emitted = yield* Queue.unbounded<{ id: string; by: string }>();
      const { world, server } = makeWorld({}, emitted);

      yield* Effect.gen(function* () {
        yield* subscribed();
        yield* Queue.offer(emitted, { id: "e1", by: "bob" });
        yield* until(() => events(world.received).length >= 1);

        expect(events(world.received)).toMatchObject([{ eventId: "e1", data: { by: "bob" } }]);
      }).pipe(Effect.provide(server));
    }),
  );

  it.effect("reads the source as the subscriber a refresh names, from then on", () => {
    const { world, server } = makeWorld();

    return Effect.gen(function* () {
      yield* subscribed();

      world.known.set("alice", { ...actors.alice, tenantId: "other" });

      yield* subscribed();

      world.changes.push(
        { id: "acme", by: "bob", onlyTenant: "acme" },
        { id: "other", by: "bob", onlyTenant: "other" },
      );

      yield* until(() => events(world.received).length >= 1);
      yield* until(() => false);

      expect(events(world.received).map(({ eventId }) => eventId)).toEqual(["other"]);
    }).pipe(Effect.provide(server));
  });

  it.effect(
    "reads on past an authorizer failing as a refresh's worker starts, still subscribed",
    () => {
      const { world, server } = makeWorld();

      return Effect.gen(function* () {
        yield* subscribed();

        world.authorizerDown = 1;

        yield* subscribed();

        world.changes.push({ id: "c1", by: "bob" });

        yield* until(() => events(world.received).length >= 1);

        const unsubscribed = yield* sent("alice", "unsubscribe", { input: {}, delivery: { url } });

        expect(events(world.received).map(({ eventId }) => eventId)).toEqual(["c1"]);
        expect(unsubscribed.status).toBe(204);
      }).pipe(Effect.provide(server));
    },
  );

  it.effect(
    "gives up an occurrence whose admission fails with no refusal, a gap told once, and reads on",
    () => {
      const { world, server } = makeWorld();
      const reported: Array<string> = [];

      return Effect.gen(function* () {
        yield* subscribed();

        world.authorizerDown = 1;
        world.changes.push({ id: "c1", by: "bob" });

        yield* until(() => false);

        world.changes.push({ id: "c2", by: "bob" });

        yield* until(() => events(world.received).length >= 1);

        expect(
          world.received
            .map(bodyOf)
            .filter(({ type }) => type !== "verification")
            .map(({ type, eventId, cursor }) => [type ?? eventId, cursor]),
        ).toEqual([
          ["gap", "1"],
          ["c2", "2"],
        ]);
        expect(reported).toHaveLength(1);
      }).pipe(Effect.provide(server), Effect.provide(ErrorReporter.layer([recorder(reported)])));
    },
  );

  it.effect(
    "ends a subscription whose refresh is refused, though its deliveries would admit it",
    () => {
      const { world, server } = makeWorld();

      return Effect.gen(function* () {
        const grant = yield* subscribed();

        world.known.set("alice", { ...actors.alice, permissions: ["users:write"] });

        const refresh = yield* sent("alice", "subscribe", {
          input: {},
          delivery: { url, secret: secretOf(1) },
        });

        world.changes.push({ id: "c1", by: "bob" });

        yield* until(() => false);

        world.known.set("alice", actors.alice);

        const unsubscribed = yield* sent("alice", "unsubscribe", { input: {}, delivery: { url } });

        expect(refresh.status).toBe(403);
        expect(
          world.received.map(bodyOf).filter(({ type }) => type !== "verification"),
        ).toMatchObject([{ type: "terminated", error: { message: "Revoked." } }]);
        expect(world.received.at(-1)?.subscription).toBe(grant.id);
        expect(unsubscribed.status).toBe(409);
      }).pipe(Effect.provide(server));
    },
  );

  it.effect("admits each delivery as the subscriber, without the subscribe request", () => {
    const { world, server } = makeWorld();

    return Effect.gen(function* () {
      yield* subscribed();

      world.changes.push({ id: "c1", by: "bob" });

      yield* until(() => events(world.received).length >= 1);

      expect(world.requested[0]).toBe(true);
      expect(world.requested.slice(1)).not.toContain(true);
      expect(world.requested.length).toBeGreaterThan(1);
    }).pipe(Effect.provide(server));
  });
});

describe("Webhook.layer", () => {
  const Login = Authentication.make("webhook-namesakes.Login", CurrentActor, {
    principal: (actor) => actor.id,
  });

  const UserChanged = Event.make("user.changed", {
    description: "A user changed.",
    payload: { id: Schema.String },
    caller: CurrentActor,
  });

  const AdminChanged = Event.make("user.changed", {
    description: "An admin changed.",
    payload: { id: Schema.String },
    caller: CurrentActor,
  });

  const quiet = (event: typeof UserChanged) =>
    Event.implement(
      event,
      { check: () => Effect.succeed({ cursor: "0", events: [] }) },
      { authorize: Event.allowAll },
    );

  const hookedRoutes = Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const hooks: Array<string> = [];

    const hooked = Event.implement(
      UserChanged,
      {
        check: () => Effect.succeed({ cursor: "0", events: [] }),
        subscription: () =>
          Effect.asVoid(
            Effect.acquireRelease(
              Effect.sync(() => hooks.push("acquired")),
              (held) =>
                held === 1
                  ? Effect.sync(() => hooks.push("releasing")).pipe(
                      Effect.andThen(Deferred.await(gate)),
                      Effect.andThen(Effect.sync(() => hooks.push("released"))),
                    )
                  : Effect.void,
            ),
          ),
      },
      { authorize: Event.allowAll },
    );

    const routes = ActionHttp.layer(
      ActionHttp.make([UserChanged], { authentication: Login }),
      hooked,
    ).pipe(
      Layer.provide(Authentication.layer(Login, verify)),
      Layer.provide(Webhook.layer({ allowedCallbacks: ["https://hooks.example.com/"] })),
      Layer.provide([
        Testing.layer(async () => new Response(null)),
        Dns.layerStatic({ hosts: { "hooks.example.com": ["93.184.216.34"] } }),
      ]),
    );

    return { gate, hooks, server: Testing.layer(routes) };
  });

  it.effect(
    "answers a refresh at once, and releases the subscription's hook before holding it again",
    () =>
      Effect.gen(function* () {
        const { gate, hooks, server } = yield* hookedRoutes;

        const meanwhile = yield* Effect.gen(function* () {
          yield* subscribed();
          yield* subscribed();
          yield* until(() => hooks.length >= 2);

          const meanwhile = [...hooks];

          yield* Deferred.succeed(gate, undefined);
          yield* until(() => hooks.length >= 4);

          return meanwhile;
        }).pipe(Effect.provide(server));

        expect(meanwhile).toEqual(["acquired", "releasing"]);
        expect(hooks).toEqual(["acquired", "releasing", "released", "acquired"]);
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "starts a subscription made after its grant lapsed once the lapsed hook is released",
    () =>
      Effect.gen(function* () {
        const { gate, hooks, server } = yield* hookedRoutes;

        const meanwhile = yield* Effect.gen(function* () {
          yield* subscribed(secretOf(1), 60_000);
          yield* TestClock.adjust("61 seconds");
          yield* until(() => hooks.length >= 2);

          const subscribing = yield* Effect.forkChild(subscribed());

          yield* until(() => hooks.length >= 3);

          const meanwhile = [...hooks];

          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.join(subscribing);
          yield* until(() => hooks.length >= 4);

          return meanwhile;
        }).pipe(Effect.provide(server));

        expect(meanwhile).toEqual(["acquired", "releasing"]);
        expect(hooks).toEqual(["acquired", "releasing", "released", "acquired"]);
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("refuses to serve two event types of one name", () =>
    Effect.gen(function* () {
      const surfaces = Layer.mergeAll(
        ActionHttp.layer(
          ActionHttp.make([UserChanged], { authentication: Login }),
          quiet(UserChanged),
        ),
        ActionMcp.layerHttp(quiet(AdminChanged), {
          name: "admins",
          version: "1.0.0",
          authentication: Login,
        }),
      ).pipe(
        Layer.provide(Authentication.layer(Login, verify)),
        Layer.provide(Webhook.layer()),
        Layer.provide([
          Testing.layer(async () => new Response(null)),
          Dns.layerStatic({ hosts: {} }),
        ]),
      );

      const exit = yield* Effect.exit(
        Effect.flatMap(HttpClient.HttpClient, (client) => client.get("/")).pipe(
          Effect.provide(Testing.layer(surfaces)),
        ),
      );

      expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
        'Webhook.layer serves "user.changed" for two event types of that name (give each event type a name of its own, or each surface its own Webhook.layer)',
      );
    }).pipe(Effect.provide(Event.layerMemory)),
  );
});
