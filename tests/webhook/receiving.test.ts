import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  type Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Schema,
  Stream,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { TestClock } from "effect/testing";
import * as Action from "../../src/contract/Action.js";
import { WebhookSecret } from "../../src/contract/callback.js";
import * as Event from "../../src/contract/Event.js";
import { type Delivered, Receiving, type Registered } from "../../src/contract/receiving.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as Testing from "../../src/testing/Testing.js";
import * as Webhook from "../../src/webhook/Webhook.js";
import { actors, CurrentActor } from "../support/app/authorization.js";
import {
  Changed,
  counting,
  Http,
  Login,
  makeWorld,
  passed,
  secretOf,
  signatureOf,
  until,
} from "../support/webhook.js";

const publicUrl = "https://hooks.example.com";

const bearer = HttpClient.mapRequest(HttpClientRequest.bearerToken("alice"));

type Received = Event.Received<typeof Changed>;

type Watching = (http: HttpClient.HttpClient) => Stream.Stream<Received, unknown, Receiving>;

const overHttp =
  (ttl?: Duration.Input, baseUrl = publicUrl): Watching =>
  (http) =>
    Stream.unwrap(
      Effect.map(
        ActionHttp.client(Http, { transformClient: bearer }).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
        ),
        (client) => client.watch(Changed, {}, { mode: Webhook.delivery({ baseUrl, ttl }) }),
      ),
    );

const overMcp =
  (baseUrl = publicUrl): Watching =>
  (http) =>
    Stream.unwrap(
      Effect.map(
        ActionMcp.client([Changed], { authentication: Login, transformClient: bearer }).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
        ),
        (client) => client.watch(Changed, {}, { mode: Webhook.delivery({ baseUrl }) }),
      ),
    );

const stubReceiving = () => {
  const places = { registered: 0 };

  const layer = Layer.succeed(Receiving, {
    path: "/alice",
    register: () =>
      Effect.sync(() => {
        places.registered += 1;

        return { id: "stub", secret: Schema.decodeSync(WebhookSecret)(secretOf(7)) };
      }),
  });

  return { places, layer };
};

const served = (...watchings: ReadonlyArray<Watching>) =>
  Effect.gen(function* () {
    const registry = yield* Deferred.make<Receiving["Service"]>();
    const seens = yield* Effect.forEach(watchings, () => Queue.unbounded<Received>());
    const ended = yield* Deferred.make<Exit.Exit<void, unknown>>();
    const callbacks: Array<string> = [];
    const receiver = Webhook.layerReceiver({ path: "/alice" });

    const captured = Layer.effectDiscard(
      Effect.flatMap(Receiving, (receiving) => Deferred.succeed(registry, receiving)),
    ).pipe(Layer.provide(receiver));

    const { world, server } = makeWorld({
      over: "both",
      callbacks: Layer.mergeAll(receiver, captured),
    });

    const started = Effect.gen(function* () {
      const receiving = yield* Deferred.await(registry);
      const http = yield* HttpClient.HttpClient;

      const recorded = Receiving.of({
        path: receiving.path,
        register: (deliver) =>
          Effect.tap(receiving.register(deliver), ({ id }) =>
            Effect.sync(() => callbacks.push(`${publicUrl}/alice?watch=${id}`)),
          ),
      });

      yield* Effect.forEach(watchings, (watching, index) =>
        Effect.forkScoped(
          Effect.flatMap(
            watching(http).pipe(
              Stream.runForEach((received) => Queue.offer(seens[index] ?? seens[0]!, received)),
              Effect.provideService(Receiving, recorded),
              Effect.exit,
            ),
            (exit) => Deferred.succeed(ended, exit),
          ),
        ),
      );

      yield* until(() => world.checks >= watchings.length);
    });

    return { world, seen: seens[0]!, seens, ended, callbacks, server: counting(server), started };
  });

const ids = (received: Iterable<Received>) =>
  Array.from(received, (each) => (each._tag === "Occurrence" ? each.eventId : "gap"));

const Reply = Schema.fromJsonString(Schema.Json);

const unsubscribedOverHttp = (callback: string) =>
  Effect.map(
    HttpClient.execute(
      HttpClientRequest.post("http://localhost/api/events/user.changed/unsubscribe").pipe(
        HttpClientRequest.bearerToken("alice"),
        HttpClientRequest.bodyJsonUnsafe({ input: {}, delivery: { url: callback } }),
      ),
    ),
    ({ status }) => status,
  );

const unsubscribedOverMcp = (callback: string) =>
  Effect.flatMap(
    HttpClient.execute(
      ActionMcp.request(
        "events/unsubscribe",
        { name: Changed.name, arguments: {}, delivery: { url: callback } },
        { headers: { authorization: "Bearer alice" } },
      ),
    ),
    (response) => Effect.map(response.text, Schema.decodeUnknownSync(Reply)),
  );

describe("watching by webhook", () => {
  it.effect("receives what the server POSTs after HTTP's subscribe route, each once", () =>
    Effect.gen(function* () {
      const { world, seen, server, started } = yield* served(overHttp());

      yield* Effect.gen(function* () {
        yield* started;

        world.changes.push({ id: "c1", by: "bob" }, { id: "c2", by: "bob" });

        yield* passed(10);

        expect(ids(yield* Queue.takeAll(seen))).toEqual(["c1", "c2"]);
      }).pipe(Effect.scoped, Effect.provide(server));
    }),
  );

  it.effect("receives what the server POSTs after MCP's events/subscribe", () =>
    Effect.gen(function* () {
      const { world, seen, server, started } = yield* served(overMcp());

      yield* Effect.gen(function* () {
        yield* started;

        world.changes.push({ id: "c1", by: "bob" });

        yield* TestClock.adjust("5 seconds");

        expect(ids(yield* Queue.takeN(seen, 1))).toEqual(["c1"]);
      }).pipe(Effect.scoped, Effect.provide(server));
    }),
  );

  it.effect("delivers to each of two watches of one url and input, each its own subscription", () =>
    Effect.gen(function* () {
      const { world, seens, server, started } = yield* served(overHttp(), overHttp());

      yield* Effect.gen(function* () {
        yield* started;

        world.changes.push({ id: "c1", by: "bob" });

        yield* TestClock.adjust("5 seconds");

        const received = yield* Effect.forEach(seens, (seen) => Queue.takeN(seen, 1));

        expect(received.map(ids)).toEqual([["c1"], ["c1"]]);
      }).pipe(Effect.scoped, Effect.provide(server));
    }),
  );

  it.effect("refreshes its subscription while it is read, past its first grant", () =>
    Effect.gen(function* () {
      const { world, seen, server, started } = yield* served(overHttp("1 minute"));

      yield* Effect.gen(function* () {
        yield* started;

        yield* passed(10 * 60);

        world.changes.push({ id: "late", by: "bob" });

        yield* TestClock.adjust("5 seconds");

        expect(ids(yield* Queue.takeN(seen, 1))).toEqual(["late"]);
      }).pipe(Effect.scoped, Effect.provide(server));
    }),
  );

  it.effect("unsubscribes when the watch ends, over HTTP and MCP alike", () =>
    Effect.gen(function* () {
      const unsubscribedAgain = yield* Effect.forEach([overHttp(), overMcp()], (watching) =>
        Effect.gen(function* () {
          const { world, ended, callbacks, server, started } = yield* served((http) =>
            watching(http).pipe(Stream.take(1)),
          );

          return yield* Effect.gen(function* () {
            yield* started;

            world.changes.push({ id: "c1", by: "bob" });

            yield* TestClock.adjust("5 seconds");
            yield* Deferred.await(ended);

            return [
              yield* unsubscribedOverHttp(callbacks[0] ?? ""),
              yield* unsubscribedOverMcp(callbacks[0] ?? ""),
            ];
          }).pipe(Effect.scoped, Effect.provide(server));
        }),
      );

      expect(unsubscribedAgain).toMatchObject(
        Array.from({ length: 2 }, () => [
          409,
          { error: { code: -32023, data: { kind: "subscription" } } },
        ]),
      );
    }),
  );

  it.effect("fails with the refusal a terminated envelope carries", () =>
    Effect.gen(function* () {
      const { world, ended, server, started } = yield* served(overHttp());

      yield* Effect.gen(function* () {
        yield* started;

        world.revoked.add("alice");
        world.changes.push({ id: "c1", by: "bob" });

        yield* TestClock.adjust("5 seconds");

        const exit = yield* Deferred.await(ended);

        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
          _tag: "Forbidden",
          message: "Revoked.",
        });
      }).pipe(Effect.scoped, Effect.provide(server));
    }),
  );

  it.effect(
    "subscribes again a second after a subscribe unanswered for 60 seconds, over HTTP and MCP alike",
    () =>
      Effect.gen(function* () {
        const { layer } = stubReceiving();

        const requests = yield* Effect.forEach([overHttp(), overMcp()], (watching) =>
          Effect.gen(function* () {
            let sent = 0;

            const unanswering = HttpClient.make(() =>
              Effect.suspend(() => {
                sent += 1;

                return Effect.never;
              }),
            ).pipe(HttpClient.mapRequest(HttpClientRequest.prependUrl("http://localhost")));

            const fiber = yield* Effect.forkChild(Stream.runDrain(watching(unanswering)));

            yield* TestClock.adjust("60 seconds");
            const unanswered = sent;
            yield* TestClock.adjust("1 second");
            const again = sent;
            const ending = yield* Effect.forkChild(Fiber.interrupt(fiber));

            yield* TestClock.adjust("2 minutes");
            yield* Fiber.join(ending);

            return [unanswered, again];
          }).pipe(Effect.provide(layer)),
        );

        expect(requests).toEqual([
          [1, 2],
          [1, 2],
        ]);
      }),
  );

  it.effect("fails with what the server refuses a subscription for, over HTTP and MCP alike", () =>
    Effect.gen(function* () {
      const { layer } = stubReceiving();

      const refusedBy = <E, R>(server: Layer.Layer<HttpClient.HttpClient, E, R>) =>
        Effect.forEach([overHttp(), overMcp()], (watching) =>
          Effect.gen(function* () {
            const exit = yield* watching(yield* HttpClient.HttpClient).pipe(
              Stream.runDrain,
              Effect.exit,
            );

            return Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
          }).pipe(Effect.provide([server, layer])),
        );

      const unanswered = makeWorld({ over: "both" });

      unanswered.world.answer = () => new Response(null, { status: 404 });

      expect(yield* refusedBy(makeWorld({ over: "both", delivering: false }).server)).toMatchObject(
        Array.from({ length: 2 }, () => ({
          _tag: "SubscriptionError",
          reason: { _tag: "Unsupported", feature: "deliveryMode", value: "webhook" },
        })),
      );
      expect(yield* refusedBy(unanswered.server)).toMatchObject(
        Array.from({ length: 2 }, () => ({
          _tag: "SubscriptionError",
          reason: { _tag: "CallbackFailed", category: "http_4xx" },
        })),
      );
    }),
  );

  it.effect(
    "fails a base url that is not an absolute https URL with a SchemaError, before it takes a place at the receiver",
    () =>
      Effect.gen(function* () {
        const { places, layer } = stubReceiving();
        const bases = ["http://hooks.example.com", "hooks.example.com", "https://"];

        const refused = yield* Effect.forEach(
          bases.flatMap((base) => [overHttp(undefined, base), overMcp(base)]),
          (watching) =>
            Effect.gen(function* () {
              const exit = yield* watching(yield* HttpClient.HttpClient).pipe(
                Stream.runDrain,
                Effect.exit,
              );

              return Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
            }),
        ).pipe(Effect.provide([makeWorld({ over: "both" }).server, layer]));

        expect(refused).toMatchObject(
          bases.flatMap(() => [{ _tag: "SchemaError" }, { _tag: "SchemaError" }]),
        );
        expect(places.registered).toBe(0);
      }),
  );

  it.effect("fails as Unsupported where the surface delivers no webhook", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(
        Event.implement(
          Changed,
          { check: () => Effect.succeed({ cursor: "0", events: [] }) },
          { authorize: Event.allowAll },
        ),
      );

      const exit = yield* client
        .watch(Changed, {}, { mode: Webhook.delivery({ baseUrl: publicUrl }) })
        .pipe(Stream.runDrain, Effect.provideService(CurrentActor, actors.alice), Effect.exit);

      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
        _tag: "SubscriptionError",
        reason: { _tag: "Unsupported", feature: "deliveryMode", value: "webhook" },
      });
    }).pipe(Effect.provide(Event.layerMemory)),
  );
});

describe("Webhook.layerReceiver", () => {
  const receiving = Effect.gen(function* () {
    const registered = yield* Deferred.make<Registered>();
    const accepted: Array<Delivered> = [];
    const room = { left: true };
    const receiver = Webhook.layerReceiver({ path: "/hooks" });

    const deliver = (body: Delivered) => {
      if (room.left) accepted.push(body);

      return room.left;
    };

    const holder = Layer.effectDiscard(
      Effect.forkScoped(
        Effect.scoped(
          Effect.flatMap(Receiving, (registry) =>
            Effect.flatMap(registry.register(deliver), (place) =>
              Effect.andThen(Deferred.succeed(registered, place), Effect.never),
            ),
          ),
        ),
      ),
    ).pipe(Layer.provide(receiver));

    return {
      registered,
      accepted,
      room,
      client: Testing.layer(Layer.provideMerge(holder, receiver)),
    };
  });

  const posted = (
    query: string,
    secret: string,
    id: string,
    at: number,
    body: Schema.Json,
    signer = secret,
  ) =>
    Effect.flatMap(
      Effect.promise(() => signatureOf(signer, id, at, JSON.stringify(body))),
      (signature) =>
        HttpClient.execute(
          HttpClientRequest.post(`https://hooks.example.com/hooks${query}`).pipe(
            HttpClientRequest.setHeaders({
              "webhook-id": id,
              "webhook-timestamp": String(at),
              "webhook-signature": signature,
            }),
            HttpClientRequest.bodyText(JSON.stringify(body), "application/json"),
          ),
        ),
    );

  const delivery = { eventId: "c1", name: "user.changed", data: { id: "c1" } };

  it.effect(
    "hands a POST its watch's secret signed to that watch once, echoes a challenge, and refuses the rest",
    () =>
      Effect.gen(function* () {
        const { registered, accepted, client } = yield* receiving;

        yield* Effect.gen(function* () {
          const { id, secret } = yield* Deferred.await(registered);
          const named = `?watch=${id}`;
          const { text } = secret;
          const stranger = secretOf(9);

          const statuses = [
            (yield* posted(named, text, "c1", 0, delivery)).status,
            (yield* posted(named, text, "c1", 0, delivery)).status,
            (yield* posted(named, text, "c2", 0, delivery, stranger)).status,
            (yield* posted(named, text, "c3", 301, delivery)).status,
            (yield* posted(named, text, "c4", -301, delivery)).status,
            (yield* posted(named, text, "c5", 0, [delivery])).status,
            (yield* posted("?watch=ended", text, "c6", 0, delivery)).status,
            (yield* posted("", text, "c7", 0, delivery)).status,
          ];

          const challenge = yield* Effect.flatMap(
            posted(named, text, "msg_verification_1", 0, {
              type: "verification",
              challenge: "abc",
            }),
            (response) => response.json,
          );

          expect(statuses).toEqual([204, 204, 401, 401, 401, 400, 410, 410]);
          expect(challenge).toEqual({ challenge: "abc" });
          expect(accepted).toEqual([delivery]);
        }).pipe(Effect.provide(client));
      }),
  );

  it.effect("answers 503 while its watch has no room, and hands it the retry", () =>
    Effect.gen(function* () {
      const { registered, accepted, room, client } = yield* receiving;

      yield* Effect.gen(function* () {
        const { id, secret } = yield* Deferred.await(registered);

        room.left = false;

        const full = (yield* posted(`?watch=${id}`, secret.text, "c1", 0, delivery)).status;

        room.left = true;

        const retried = (yield* posted(`?watch=${id}`, secret.text, "c1", 0, delivery)).status;

        expect([full, retried]).toEqual([503, 204]);
        expect(accepted).toEqual([delivery]);
      }).pipe(Effect.provide(client));
    }),
  );
});
