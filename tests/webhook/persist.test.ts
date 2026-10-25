import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, ErrorReporter, Exit, Fiber, Layer, Schema, Scope } from "effect";
import { HttpClient } from "effect/http";
import { Dns } from "effect/net";
import { KeyValueStore } from "effect/persistence";
import { TestClock } from "effect/testing";
import * as Authentication from "../../src/authentication/Authentication.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as Testing from "../../src/testing/Testing.js";
import { Stored } from "../../src/webhook/stored.js";
import * as Webhook from "../../src/webhook/Webhook.js";
import { verify } from "../support/app/authentication.js";
import { type Actor, CurrentActor } from "../support/app/authorization.js";
import { recorder } from "../support/reporter.js";
import {
  acknowledging,
  bodyOf,
  events,
  makeWorld,
  passed,
  secretOf,
  sent,
  signedBy,
  subscribed,
  until,
  url,
} from "../support/webhook.js";

const index = "effect-actions/webhook";

const keptIds = (store: KeyValueStore.KeyValueStore) =>
  Effect.map(store.get(index), (ids) =>
    ids === undefined
      ? []
      : Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(ids),
  );

describe("webhook subscriptions kept by persist", () => {
  it.effect(
    "restores a kept subscription as its surface builds again, delivering on from its watermark",
    () =>
      Effect.gen(function* () {
        const store = yield* KeyValueStore.KeyValueStore;
        const before = makeWorld({}, undefined, store);
        const after = makeWorld({}, undefined, store);

        const grant = yield* Effect.gen(function* () {
          const grant = yield* subscribed(secretOf(1));

          before.world.changes.push({ id: "c1", by: "bob" });

          yield* until(() => events(before.world.received).length === 1);

          return grant;
        }).pipe(Effect.provide(before.server));

        after.world.changes.push({ id: "c1", by: "bob" }, { id: "c2", by: "bob" });

        yield* Effect.gen(function* () {
          yield* until(() => events(after.world.received).length === 1);
        }).pipe(Effect.provide(after.server));

        const [delivery] = after.world.received;

        expect(events(after.world.received)).toMatchObject([{ eventId: "c2", cursor: "2" }]);
        expect(delivery?.subscription).toBe(grant.id);
        expect(delivery && (yield* Effect.promise(() => signedBy(secretOf(1), delivery)))).toBe(
          true,
        );
        expect(yield* keptIds(store)).toEqual([grant.id]);
      }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect("restores over MCP a subscription made over HTTP, as the MCP endpoint builds", () =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;
      const before = makeWorld({}, undefined, store);
      const after = makeWorld({}, undefined, store, "MCP");

      const grant = yield* subscribed(secretOf(1)).pipe(Effect.provide(before.server));

      after.world.changes.push({ id: "c1", by: "bob" });

      yield* until(() => events(after.world.received).length === 1).pipe(
        Effect.provide(after.server),
      );

      expect(after.world.received.map((delivery) => delivery.subscription)).toEqual([grant.id]);
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect(
    "removes a subscription that is unsubscribed, or that expires, and restores neither",
    () =>
      Effect.gen(function* () {
        const store = yield* KeyValueStore.KeyValueStore;
        const before = makeWorld({}, undefined, store);
        const after = makeWorld({}, undefined, store);

        yield* Effect.gen(function* () {
          yield* subscribed(secretOf(1), 60_000);
          yield* subscribed(secretOf(2), null, { token: "bob" });
          yield* sent("bob", "unsubscribe", { input: {}, delivery: { url } });
        }).pipe(Effect.provide(before.server));

        const keptBetween = yield* keptIds(store);

        yield* TestClock.adjust("2 minutes");

        after.world.changes.push({ id: "c1", by: "bob" });

        yield* passed().pipe(Effect.provide(after.server));

        expect(keptBetween).toHaveLength(1);
        expect(events(after.world.received)).toEqual([]);
        expect(yield* keptIds(store)).toEqual([]);
      }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect(
    "lists a subscription whose index write failed at its next write, so a restart restores it",
    () =>
      Effect.gen(function* () {
        const memory = yield* KeyValueStore.KeyValueStore;
        let indexWrites = 0;

        const failingFirstIndexWrite: KeyValueStore.KeyValueStore = {
          ...memory,
          set: (key, value) =>
            key === index && (indexWrites += 1) === 1
              ? Effect.die(new Error("The store is down."))
              : memory.set(key, value),
        };

        const before = makeWorld({}, undefined, failingFirstIndexWrite);
        const after = makeWorld({}, undefined, memory);

        const grant = yield* Effect.gen(function* () {
          const grant = yield* subscribed(secretOf(1));

          before.world.changes.push({ id: "c1", by: "bob" });

          yield* until(() => events(before.world.received).length === 1);

          return grant;
        }).pipe(Effect.provide(before.server));

        after.world.changes.push({ id: "c1", by: "bob" }, { id: "c2", by: "bob" });

        yield* Effect.gen(function* () {
          yield* until(() => events(after.world.received).length === 1);
        }).pipe(Effect.provide(after.server));

        expect([indexWrites, yield* keptIds(memory)]).toEqual([2, [grant.id]]);
        expect(events(after.world.received)).toMatchObject([{ eventId: "c2" }]);
      }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect("removes a subscription its own expiry ends while the layer runs", () =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;
      const { server } = makeWorld({}, undefined, store);

      const keptLive = yield* Effect.gen(function* () {
        yield* subscribed(secretOf(1), 60_000);
        yield* Effect.repeat(Effect.yieldNow, { times: 10 });

        const kept = yield* keptIds(store);

        yield* TestClock.adjust("2 minutes");

        return kept;
      }).pipe(Effect.provide(server));

      expect(keptLive).toHaveLength(1);
      expect(yield* keptIds(store)).toEqual([]);
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect(
    "grants a subscription asking for no expiry the longest, and ends one suspended at its grant, removing what was kept",
    () =>
      Effect.gen(function* () {
        const store = yield* KeyValueStore.KeyValueStore;
        const { world, server } = makeWorld({ retryFor: "10 seconds" }, undefined, store);

        const [grant, suspended] = yield* Effect.gen(function* () {
          const grant = yield* subscribed(secretOf(1), null);

          world.answer = (body) =>
            body["type"] === undefined ? new Response(null, { status: 500 }) : acknowledging(body);
          world.changes.push({ id: "c1", by: "bob" });

          yield* passed();

          const kept = yield* store.get(`${index}/${grant.id}`);

          const suspended = [
            yield* keptIds(store),
            kept === undefined
              ? kept
              : Schema.decodeUnknownSync(Schema.fromJsonString(Stored))(kept).status.active,
          ];

          yield* TestClock.adjust("1 hour");
          yield* passed();

          return [grant, suspended] as const;
        }).pipe(Effect.provide(server));

        expect(grant.refreshBefore).toBe(new Date(60 * 60 * 1000).toISOString());
        expect([suspended, yield* keptIds(store)]).toEqual([[[grant.id], false], []]);
      }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect(
    "reports a kept subscription whose identity no longer decodes, restores the rest, and removes it when it is unsubscribed",
    () =>
      Effect.gen(function* () {
        const store = yield* KeyValueStore.KeyValueStore;
        const reported: Array<string> = [];
        const before = makeWorld({}, undefined, store);
        const after = makeWorld({}, undefined, store);

        const [alice, bob] = yield* Effect.all([
          subscribed(secretOf(1)),
          subscribed(secretOf(2), undefined, { token: "bob" }),
        ]).pipe(Effect.provide(before.server));

        const key = `${index}/${bob.id}`;

        yield* store.set(
          key,
          JSON.stringify({ ...JSON.parse((yield* store.get(key)) ?? "{}"), identity: { id: 7 } }),
        );

        after.world.changes.push({ id: "c1", by: "bob" });

        const [keptMeanwhile, unsubscribed] = yield* Effect.gen(function* () {
          yield* until(() => events(after.world.received).length === 1);

          const keptMeanwhile = yield* store.has(key);
          const response = yield* sent("bob", "unsubscribe", { input: {}, delivery: { url } });

          return [keptMeanwhile, response.status] as const;
        }).pipe(
          Effect.provide(after.server),
          Effect.provide(ErrorReporter.layer([recorder(reported)])),
        );

        expect(after.world.received.map((delivery) => delivery.subscription)).toEqual([alice.id]);
        expect(reported).toHaveLength(1);
        expect([keptMeanwhile, unsubscribed]).toEqual([true, 204]);
        expect(yield* store.has(key)).toBe(false);
      }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect("posts terminated to a subscriber refused as its subscription is restored", () =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;
      const before = makeWorld({}, undefined, store);
      const after = makeWorld({}, undefined, store);

      yield* subscribed(secretOf(1)).pipe(Effect.provide(before.server));

      after.world.revoked.add("alice");

      yield* until(() => after.world.received.length === 1).pipe(Effect.provide(after.server));

      expect(after.world.received.map(bodyOf)).toMatchObject([
        { type: "terminated", error: { message: "Revoked." } },
      ]);
      expect(yield* keptIds(store)).toEqual([]);
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect("resumes a restored subscription whose source fails its first read", () =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;
      const reported: Array<string> = [];
      const before = makeWorld({}, undefined, store);
      const after = makeWorld({}, undefined, store);

      yield* subscribed(secretOf(1)).pipe(Effect.provide(before.server));

      after.world.failures = 1;
      after.world.changes.push({ id: "c1", by: "bob" });

      yield* until(() => events(after.world.received).length === 1).pipe(
        Effect.provide(after.server),
        Effect.provide(ErrorReporter.layer([recorder(reported)])),
      );

      expect(events(after.world.received)).toMatchObject([{ eventId: "c1" }]);
      expect(reported).toHaveLength(1);
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect("keeps and resumes a restored subscription whose authorizer fails as it starts", () =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;
      const reported: Array<string> = [];
      const before = makeWorld({}, undefined, store);
      const after = makeWorld({}, undefined, store);

      const grant = yield* subscribed(secretOf(1)).pipe(Effect.provide(before.server));

      after.world.authorizerDown = 1;
      after.world.changes.push({ id: "c1", by: "bob" });

      yield* until(() => events(after.world.received).length === 1).pipe(
        Effect.provide(after.server),
        Effect.provide(ErrorReporter.layer([recorder(reported)])),
      );

      expect(events(after.world.received)).toMatchObject([{ eventId: "c1" }]);
      expect(reported).toHaveLength(1);
      expect(yield* keptIds(store)).toEqual([grant.id]);
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect(
    "names a subscription by its callback as parsed, so one restored is unsubscribed as it was made",
    () =>
      Effect.gen(function* () {
        const store = yield* KeyValueStore.KeyValueStore;
        const callback = "https://hooks.example.com:443/alice";
        const before = makeWorld({}, undefined, store);
        const after = makeWorld({}, undefined, store);

        const grant = yield* subscribed(secretOf(1), undefined, { callback }).pipe(
          Effect.provide(before.server),
        );

        const [refreshed, unsubscribed] = yield* Effect.gen(function* () {
          const refreshed = yield* subscribed(secretOf(1), undefined, { callback });

          const response = yield* sent("alice", "unsubscribe", {
            input: {},
            delivery: { url: callback },
          });

          return [refreshed.id, response.status] as const;
        }).pipe(Effect.provide(after.server));

        expect([refreshed, unsubscribed]).toEqual([grant.id, 204]);
        expect(yield* keptIds(store)).toEqual([]);
      }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect(
    "removes an id its index lists with no record, and keeps one whose record fails to read",
    () =>
      Effect.gen(function* () {
        const memory = yield* KeyValueStore.KeyValueStore;
        const reported: Array<string> = [];
        const before = makeWorld({}, undefined, memory);

        const grant = yield* subscribed(secretOf(1)).pipe(Effect.provide(before.server));

        yield* memory.set(index, JSON.stringify([grant.id, "ghost"]));

        const failingReads: KeyValueStore.KeyValueStore = {
          ...memory,
          get: (key) =>
            key === `${index}/${grant.id}`
              ? Effect.die(new Error("The store is down."))
              : memory.get(key),
        };

        const after = makeWorld({}, undefined, failingReads);

        yield* passed().pipe(
          Effect.provide(after.server),
          Effect.provide(ErrorReporter.layer([recorder(reported)])),
        );

        expect(yield* keptIds(memory)).toEqual([grant.id]);
        expect(reported).toHaveLength(1);
      }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect(
    "restores a failing subscription with the retry budget its failures began, waiting as long as it has failed",
    () =>
      Effect.gen(function* () {
        const store = yield* KeyValueStore.KeyValueStore;
        const before = makeWorld({ retryFor: "90 seconds" }, undefined, store);
        const after = makeWorld({ retryFor: "90 seconds" }, undefined, store);

        const failing: typeof before.world.answer = (body) =>
          body["type"] === undefined ? new Response(null, { status: 500 }) : acknowledging(body);

        yield* Effect.gen(function* () {
          yield* subscribed(secretOf(1));

          before.world.answer = failing;
          before.world.changes.push({ id: "c1", by: "bob" });

          yield* passed();
        }).pipe(Effect.provide(before.server));

        after.world.answer = failing;
        after.world.changes.push({ id: "c1", by: "bob" });

        const refreshed = yield* Effect.gen(function* () {
          yield* passed();

          return yield* subscribed(secretOf(1));
        }).pipe(Effect.provide(after.server));

        expect(events(after.world.received).length).toBeLessThanOrEqual(3);
        expect(refreshed.deliveryStatus).toMatchObject({ active: false, lastError: "http_5xx" });
      }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect("restores a suspended subscription suspended, delivering again at its refresh", () =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;
      const before = makeWorld({ retryFor: "10 seconds" }, undefined, store);
      const after = makeWorld({ retryFor: "10 seconds" }, undefined, store);

      yield* Effect.gen(function* () {
        yield* subscribed(secretOf(1));

        before.world.answer = (body) =>
          body["type"] === undefined ? new Response(null, { status: 500 }) : acknowledging(body);
        before.world.changes.push({ id: "c1", by: "bob" });

        yield* passed();
      }).pipe(Effect.provide(before.server));

      after.world.changes.push({ id: "c1", by: "bob" });

      const [restored, refreshed] = yield* Effect.gen(function* () {
        yield* passed();

        const restored = events(after.world.received).length;
        const refresh = yield* subscribed(secretOf(1));

        yield* until(() => events(after.world.received).length >= 1);

        return [restored, refresh.deliveryStatus?.active] as const;
      }).pipe(Effect.provide(after.server));

      expect([restored, refreshed]).toEqual([0, false]);
      expect(events(after.world.received)).toMatchObject([{ eventId: "c1" }]);
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect(
    "unsubscribes a subscription restored suspended, which a subscribe then starts afresh",
    () =>
      Effect.gen(function* () {
        const store = yield* KeyValueStore.KeyValueStore;
        const before = makeWorld({ retryFor: "10 seconds" }, undefined, store);
        const after = makeWorld({ retryFor: "10 seconds" }, undefined, store);

        yield* Effect.gen(function* () {
          yield* subscribed(secretOf(1));

          before.world.answer = (body) =>
            body["type"] === undefined ? new Response(null, { status: 500 }) : acknowledging(body);
          before.world.changes.push({ id: "c1", by: "bob" });

          yield* passed();
        }).pipe(Effect.provide(before.server));

        after.world.changes.push({ id: "c1", by: "bob" }, { id: "c2", by: "bob" });

        const outcome = yield* Effect.gen(function* () {
          const first = yield* sent("alice", "unsubscribe", { input: {}, delivery: { url } });
          const second = yield* sent("alice", "unsubscribe", { input: {}, delivery: { url } });
          const fresh = yield* subscribed(secretOf(2));

          return { statuses: [first.status, second.status], fresh };
        }).pipe(Effect.provide(after.server));

        expect(outcome).toMatchObject({ statuses: [204, 409], fresh: { cursor: "2" } });
        expect(outcome.fresh).not.toHaveProperty("deliveryStatus");
      }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect("restores the identity its latest refresh was made with", () =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;
      const { world, server } = makeWorld({}, undefined, store);
      const narrowed: Actor = { id: "alice", tenantId: "acme", permissions: ["users:read"] };

      const grant = yield* Effect.gen(function* () {
        yield* subscribed(secretOf(1));

        world.known.set("alice", narrowed);

        return yield* subscribed(secretOf(1));
      }).pipe(Effect.provide(server));

      const kept = Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Struct({ identity: Schema.Json })),
      )(yield* store.get(`${index}/${grant.id}`));

      expect(kept.identity).toEqual(narrowed);
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect("holds up neither a subscribe nor a delivery behind a store that never answers", () =>
    Effect.gen(function* () {
      const memory = yield* KeyValueStore.KeyValueStore;
      const hanging = KeyValueStore.KeyValueStore.of({ ...memory, set: () => Effect.never });
      const { world, server } = makeWorld({}, undefined, hanging);
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(server, scope);

      const grant = yield* subscribed(secretOf(1)).pipe(Effect.provide(context));

      world.changes.push({ id: "c1", by: "bob" });

      yield* until(() => events(world.received).length === 1).pipe(Effect.provide(context));

      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));

      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(closing);

      expect(grant.cursor).toBe("0");
      expect(events(world.received)).toMatchObject([{ eventId: "c1" }]);
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect("restores a subscription once where two surfaces serve one layer", () =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;
      const before = makeWorld({}, undefined, store);
      const after = makeWorld({}, undefined, store, "both");

      yield* subscribed(secretOf(1)).pipe(Effect.provide(before.server));

      after.world.changes.push({ id: "c1", by: "bob" });

      yield* Effect.gen(function* () {
        yield* until(() => events(after.world.received).length > 0);
        yield* passed();
      }).pipe(Effect.provide(after.server));

      expect(events(after.world.received)).toMatchObject([{ eventId: "c1" }]);
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect("carries a subscription's delivery status through a restore", () =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;
      const before = makeWorld({}, undefined, store);
      const after = makeWorld({}, undefined, store);

      const status = yield* Effect.gen(function* () {
        yield* subscribed(secretOf(1));

        before.world.changes.push({ id: "c1", by: "bob" });

        yield* until(() => events(before.world.received).length === 1);

        return (yield* subscribed(secretOf(1))).deliveryStatus;
      }).pipe(Effect.provide(before.server));

      const restored = yield* subscribed(secretOf(1)).pipe(Effect.provide(after.server));

      expect(status?.lastDeliveryAt).not.toBeNull();
      expect(restored.deliveryStatus).toEqual(status);
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );

  it.effect("moves a kept subscription to the id its subscriber now has", () =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;
      const before = makeWorld({}, undefined, store);
      const after = makeWorld({}, undefined, store);

      const grant = yield* subscribed(secretOf(1)).pipe(Effect.provide(before.server));

      yield* store.set(`${index}/stale`, (yield* store.get(`${index}/${grant.id}`)) ?? "");
      yield* store.remove(`${index}/${grant.id}`);
      yield* store.set(index, JSON.stringify(["stale"]));

      after.world.changes.push({ id: "c1", by: "bob" });

      yield* until(() => events(after.world.received).length === 1).pipe(
        Effect.provide(after.server),
      );

      expect(after.world.received.map((delivery) => delivery.subscription)).toEqual([grant.id]);
      expect(yield* keptIds(store)).toEqual([grant.id]);
    }).pipe(Effect.provide(KeyValueStore.layerMemory)),
  );
});

const Changed = Event.make("user.changed", {
  description: "A user changed.",
  payload: { id: Schema.String },
  caller: CurrentActor,
});

const Unkept = Authentication.make("webhook-persist.Unkept", CurrentActor, {
  principal: (actor) => actor.id,
});

const implementation = Event.implement(
  Changed,
  { check: () => Effect.succeed({ cursor: "0", events: [] }) },
  { authorize: Event.allowAll },
);

const Member = Schema.Struct({
  id: Schema.String,
  tenantId: Schema.String,
  permissions: Schema.Array(Schema.Literals(["users:read", "users:write"])),
});

const Bearer = Authentication.make("webhook-persist.Bearer", CurrentActor, {
  principal: (actor) => actor.id,
  schema: Member,
});

const OAuth = Authentication.make("webhook-persist.OAuth", CurrentActor, {
  principal: (actor) => actor.id,
  schema: Schema.Struct(Member.fields),
});

const persisted = Webhook.layer({ persist: true }).pipe(
  Layer.provide([
    KeyValueStore.layerMemory,
    Testing.layer(async () => new Response(null)),
    Dns.layerStatic({ hosts: {} }),
  ]),
);

describe("Webhook.layer with persist", () => {
  it.effect(
    "refuses to serve a protected event by webhook where its authentication has no schema, over HTTP and MCP alike",
    () =>
      Effect.gen(function* () {
        const surfaces = [
          ActionHttp.layer(ActionHttp.make([Changed], { authentication: Unkept }), implementation),
          ActionMcp.layerHttp(implementation, {
            name: "persist",
            version: "1.0.0",
            authentication: Unkept,
          }),
        ];

        const refusals = yield* Effect.forEach(surfaces, (surface) =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(
              Effect.flatMap(HttpClient.HttpClient, (client) => client.get("/")).pipe(
                Effect.provide(
                  Testing.layer(
                    surface.pipe(
                      Layer.provide(Authentication.layer(Unkept, verify)),
                      Layer.provide(persisted),
                    ),
                  ),
                ),
              ),
            );

            return Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";
          }),
        );

        expect(refusals).toEqual([
          expect.stringContaining(
            'Webhook.layer persists webhook subscriptions, but the authentication of "user.changed" has no schema to keep a subscriber\'s identity by (give its Authentication.make a schema)',
          ),
          expect.stringContaining("has no schema to keep a subscriber's identity by"),
        ]);
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("refuses an event two authentications with different schemas serve", () =>
    Effect.gen(function* () {
      const surfaces = Layer.mergeAll(
        ActionHttp.layer(ActionHttp.make([Changed], { authentication: Bearer }), implementation),
        ActionMcp.layerHttp(implementation, {
          name: "persist",
          version: "1.0.0",
          authentication: OAuth,
        }),
      ).pipe(
        Layer.provide([Authentication.layer(Bearer, verify), Authentication.layer(OAuth, verify)]),
        Layer.provide(persisted),
      );

      const exit = yield* Effect.exit(
        Effect.flatMap(HttpClient.HttpClient, (client) => client.get("/")).pipe(
          Effect.provide(Testing.layer(surfaces)),
        ),
      );

      expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
        'Webhook.layer persists webhook subscriptions, but "user.changed" is served by two authentications with different schemas (serve each event with one authentication, or give them one schema)',
      );
    }).pipe(Effect.provide(Event.layerMemory)),
  );
});
