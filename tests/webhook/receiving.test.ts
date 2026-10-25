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
import { Dns } from "effect/net";
import { TestClock } from "effect/testing";
import * as Action from "../../src/contract/Action.js";
import * as Authentication from "../../src/authentication/Authentication.js";
import * as Event from "../../src/contract/Event.js";
import {
  type Delivered,
  Receiving,
  type Registered,
  webhookFed,
} from "../../src/contract/webhooks.js";
import { transportOf as mcpTransportOf } from "../../src/mcp/watch.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as Testing from "../../src/testing/Testing.js";
import * as Webhook from "../../src/webhook/Webhook.js";
import { verify } from "../support/app/authentication.js";
import { actors, CurrentActor } from "../support/app/authorization.js";
import { counting, passed, until } from "../support/webhook.js";

const Changed = Event.make("user.changed", {
  description: "A user changed.",
  payload: { id: Schema.String },
  caller: CurrentActor,
});

const Login = Authentication.make("webhook-receiving.Login", CurrentActor, {
  principal: (actor) => actor.id,
});

const Http = ActionHttp.make([Changed], { authentication: Login });

const url = "https://hooks.example.com/alice";

const bearer = HttpClient.mapRequest(HttpClientRequest.bearerToken("alice"));

type Received = Event.Received<typeof Changed>;

interface World {
  readonly changes: Array<{ readonly id: string }>;
  readonly revoked: Set<string>;
  checks: number;
}

const makeWorld = (): World => ({ changes: [], revoked: new Set(), checks: 0 });

const implementationOf = (world: World) =>
  Event.implement(
    Changed,
    {
      check: (_input, cursor) =>
        Effect.sync(() => {
          world.checks += 1;

          return {
            cursor: String(world.changes.length),
            events: world.changes
              .slice(cursor === null ? world.changes.length : Number(cursor))
              .map((data) => ({ eventId: data.id, data })),
          };
        }),
    },
    {
      authorize: () =>
        Effect.flatMap(CurrentActor, (actor) =>
          world.revoked.has(actor.id)
            ? Effect.fail(new Action.Forbidden({ message: "Revoked." }))
            : Effect.void,
        ),
    },
  );

type Watching = (http: HttpClient.HttpClient) => Stream.Stream<Received, unknown>;

const overHttp =
  (ttl?: Duration.Input, callback = url): Watching =>
  (http) =>
    Stream.unwrap(
      Effect.map(
        ActionHttp.client(Http, { transformClient: bearer }).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
        ),
        (client) => client.watch(Changed, {}, { mode: Webhook.delivery({ url: callback, ttl }) }),
      ),
    );

const overMcp =
  (callback = url): Watching =>
  (http) =>
    Stream.unwrap(
      Effect.map(
        ActionMcp.client([Changed], { authentication: Login, transformClient: bearer }).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
        ),
        (client) => client.watch(Changed, {}, { mode: Webhook.delivery({ url: callback }) }),
      ),
    );

const routesOf = (world: World) =>
  Layer.mergeAll(
    ActionHttp.layer(Http, implementationOf(world)),
    ActionMcp.layerHttp(implementationOf(world), {
      name: "receiving",
      version: "1.0.0",
      authentication: Login,
    }),
  ).pipe(Layer.provide(Authentication.layer(Login, verify)));

const publicName = Dns.layerStatic({ hosts: { "hooks.example.com": ["93.184.216.34"] } });

const served = (...watchings: ReadonlyArray<Watching>) =>
  Effect.gen(function* () {
    const world = makeWorld();
    const registry = yield* Deferred.make<Receiving["Service"]>();
    const seens = yield* Effect.forEach(watchings, () => Queue.unbounded<Received>());
    const ended = yield* Deferred.make<Exit.Exit<void, unknown>>();
    const callbacks: Array<string> = [];
    const receiver = Webhook.layerReceiver({ path: "/alice" });

    const captured = Layer.effectDiscard(
      Effect.flatMap(Receiving, (receiving) => Deferred.succeed(registry, receiving)),
    ).pipe(Layer.provide(receiver));

    const server = routesOf(world).pipe(
      Layer.provide(Webhook.layer()),
      Layer.provide([counting(Testing.layer(Layer.mergeAll(receiver, captured))), publicName]),
    );

    const started = Effect.gen(function* () {
      const receiving = yield* Deferred.await(registry);
      const http = yield* HttpClient.HttpClient;

      const recorded = Receiving.of({
        register: (deliver) =>
          Effect.tap(receiving.register(deliver), ({ id }) =>
            Effect.sync(() => callbacks.push(`${url}?watch=${id}`)),
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

    return {
      world,
      seen: seens[0]!,
      seens,
      ended,
      callbacks,
      server: counting(Testing.layer(server)),
      started,
    };
  });

const ids = (received: Iterable<Received>) =>
  Array.from(received, (each) => (each._tag === "Occurrence" ? each.eventId : "gap"));

const unsubscribedOverHttp = (callback: string) =>
  HttpClient.execute(
    HttpClientRequest.post("http://localhost/api/events/user.changed/unsubscribe").pipe(
      HttpClientRequest.bearerToken("alice"),
      HttpClientRequest.bodyJsonUnsafe({ input: {}, delivery: { url: callback } }),
    ),
  );

const unsubscribedOverMcp = (callback: string) =>
  Effect.flatMap(HttpClient.HttpClient, (http) =>
    Effect.flip(
      mcpTransportOf(
        { http: bearer(http), url: "/mcp", event: Changed, refusedWith: [] },
        {},
      ).webhook?.unsubscribe(callback) ?? Effect.die(new Error("MCP has no webhook transport")),
    ),
  );

describe("watching by webhook", () => {
  it.effect("receives what the server POSTs after HTTP's subscribe route, each once", () =>
    Effect.gen(function* () {
      const { world, seen, server, started } = yield* served(overHttp());

      yield* Effect.gen(function* () {
        yield* started;

        world.changes.push({ id: "c1" }, { id: "c2" });

        yield* TestClock.adjust("5 seconds");

        expect(ids(yield* Queue.takeN(seen, 2))).toEqual(["c1", "c2"]);
      }).pipe(Effect.scoped, Effect.provide(server));
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("receives what the server POSTs after MCP's events/subscribe", () =>
    Effect.gen(function* () {
      const { world, seen, server, started } = yield* served(overMcp());

      yield* Effect.gen(function* () {
        yield* started;

        world.changes.push({ id: "c1" });

        yield* TestClock.adjust("5 seconds");

        expect(ids(yield* Queue.takeN(seen, 1))).toEqual(["c1"]);
      }).pipe(Effect.scoped, Effect.provide(server));
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("delivers to each of two watches of one url and input, each its own subscription", () =>
    Effect.gen(function* () {
      const { world, seens, server, started } = yield* served(overHttp(), overHttp());

      yield* Effect.gen(function* () {
        yield* started;

        world.changes.push({ id: "c1" });

        yield* TestClock.adjust("5 seconds");

        const received = yield* Effect.forEach(seens, (seen) => Queue.takeN(seen, 1));

        expect(received.map(ids)).toEqual([["c1"], ["c1"]]);
      }).pipe(Effect.scoped, Effect.provide(server));
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("refreshes its subscription while it is read, past its first grant", () =>
    Effect.gen(function* () {
      const { world, seen, server, started } = yield* served(overHttp("1 minute"));

      yield* Effect.gen(function* () {
        yield* started;

        yield* passed(10 * 60);

        world.changes.push({ id: "late" });

        yield* TestClock.adjust("5 seconds");

        expect(ids(yield* Queue.takeN(seen, 1))).toEqual(["late"]);
      }).pipe(Effect.scoped, Effect.provide(server));
    }).pipe(Effect.provide(Event.layerMemory)),
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

            world.changes.push({ id: "c1" });

            yield* TestClock.adjust("5 seconds");
            yield* Deferred.await(ended);

            return [
              (yield* unsubscribedOverHttp(callbacks[0] ?? "")).status,
              yield* unsubscribedOverMcp(callbacks[0] ?? ""),
            ];
          }).pipe(Effect.scoped, Effect.provide(server));
        }),
      );

      expect(unsubscribedAgain).toMatchObject(
        Array.from({ length: 2 }, () => [
          409,
          { _tag: "SubscriptionError", reason: { _tag: "NotSubscribed" } },
        ]),
      );
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("fails with the refusal a terminated envelope carries", () =>
    Effect.gen(function* () {
      const { world, ended, server, started } = yield* served(overHttp());

      yield* Effect.gen(function* () {
        yield* started;

        world.revoked.add("alice");
        world.changes.push({ id: "c1" });

        yield* TestClock.adjust("5 seconds");

        const exit = yield* Deferred.await(ended);

        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
          _tag: "Forbidden",
          message: "Revoked.",
        });
      }).pipe(Effect.scoped, Effect.provide(server));
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "fails with the reason a terminated envelope's code names, and the refusal for any other",
    () =>
      Effect.gen(function* () {
        const read = webhookFed(Changed);

        const failures = yield* Effect.forEach(
          [
            { code: -32023, message: "Event removed", data: { kind: "event" } },
            { code: -32026, message: "Schema changed", data: { feature: "schema" } },
            { code: -32024, message: "Revoked.", data: { _tag: "Forbidden", message: "Revoked." } },
            { code: -32000, message: "Ended." },
          ],
          (error) => Effect.flip(read({ type: "terminated", error })),
        );

        expect(failures).toMatchObject([
          { _tag: "SubscriptionError", reason: { _tag: "NotServed" } },
          { _tag: "SubscriptionError", reason: { _tag: "Unsupported", feature: "schema" } },
          { _tag: "Forbidden", message: "Revoked." },
          { _tag: "Forbidden", message: "Ended." },
        ]);
      }),
  );

  it.effect(
    "subscribes again after a subscribe unanswered for 60 seconds, over HTTP and MCP alike",
    () =>
      Effect.gen(function* () {
        const receiving = Layer.succeed(Receiving, {
          register: () =>
            Effect.succeed({
              id: "stub",
              secret: `whsec_${Buffer.alloc(32, 7).toString("base64")}`,
            }),
        });

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

            yield* TestClock.adjust("0 millis");
            yield* TestClock.adjust("2 minutes");
            const counted = sent;
            const ending = yield* Effect.forkChild(Fiber.interrupt(fiber));

            yield* TestClock.adjust("2 minutes");
            yield* Fiber.join(ending);

            return counted;
          }).pipe(Effect.provide(receiving)),
        );

        expect(requests).toEqual([2, 2]);
      }),
  );

  it.effect("fails with what the server refuses a subscription for, over HTTP and MCP alike", () =>
    Effect.gen(function* () {
      const receiving = Layer.succeed(Receiving, {
        register: () =>
          Effect.succeed({ id: "stub", secret: `whsec_${Buffer.alloc(32, 7).toString("base64")}` }),
      });

      const refusedBy = <E, R>(server: Layer.Layer<never, E, R>) =>
        Effect.forEach([overHttp(), overMcp()], (watching) =>
          Effect.gen(function* () {
            const exit = yield* watching(yield* HttpClient.HttpClient).pipe(
              Stream.runDrain,
              Effect.exit,
            );

            return Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
          }).pipe(Effect.provide([Testing.layer(server), receiving])),
        );

      const withoutWebhooks = routesOf(makeWorld());

      const unanswered = routesOf(makeWorld()).pipe(
        Layer.provide(Webhook.layer()),
        Layer.provide([Testing.layer(async () => new Response(null, { status: 404 })), publicName]),
      );

      expect(yield* refusedBy(withoutWebhooks)).toMatchObject(
        Array.from({ length: 2 }, () => ({
          _tag: "SubscriptionError",
          reason: { _tag: "Unsupported", feature: "deliveryMode", value: "webhook" },
        })),
      );
      expect(yield* refusedBy(unanswered)).toMatchObject(
        Array.from({ length: 2 }, () => ({
          _tag: "SubscriptionError",
          reason: { _tag: "CallbackFailed", category: "http_4xx" },
        })),
      );
    }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect(
    "refuses a url that is not https, HTTP's client by its schema and MCP's endpoint as InvalidInput",
    () =>
      Effect.gen(function* () {
        const receiving = Layer.succeed(Receiving, {
          register: () =>
            Effect.succeed({
              id: "stub",
              secret: `whsec_${Buffer.alloc(32, 7).toString("base64")}`,
            }),
        });

        const plain = "http://hooks.example.com/alice";

        const refused = yield* Effect.forEach(
          [overHttp(undefined, plain), overMcp(plain)],
          (watching) =>
            Effect.gen(function* () {
              const exit = yield* watching(yield* HttpClient.HttpClient).pipe(
                Stream.runDrain,
                Effect.exit,
              );

              return Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
            }),
        ).pipe(
          Effect.provide([
            Testing.layer(
              routesOf(makeWorld()).pipe(
                Layer.provide(Webhook.layer()),
                Layer.provide([Testing.layer(async () => new Response(null)), publicName]),
              ),
            ),
            receiving,
          ]),
        );

        expect(refused).toMatchObject([{ _tag: "SchemaError" }, { _tag: "InvalidInput" }]);
      }).pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("dies naming Webhook.layerReceiver where no receiver is provided", () =>
    Effect.gen(function* () {
      const exit = yield* overHttp()(yield* HttpClient.HttpClient).pipe(
        Stream.runDrain,
        Effect.exit,
      );

      expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
        "A watch by webhook found no receiver",
      );
    })
      .pipe(Effect.provide(Testing.layer(routesOf(makeWorld()))))
      .pipe(Effect.provide(Event.layerMemory)),
  );

  it.effect("fails as Unsupported where the surface delivers no webhook", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(implementationOf(makeWorld()));

      const exit = yield* client
        .watch(Changed, {}, { mode: Webhook.delivery({ url }) })
        .pipe(Stream.runDrain, Effect.provideService(CurrentActor, actors.alice), Effect.exit);

      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
        _tag: "SubscriptionError",
        reason: { _tag: "Unsupported", feature: "deliveryMode", value: "webhook" },
      });
    }).pipe(Effect.provide(Event.layerMemory)),
  );
});

const signed = async (secret: string, id: string, timestamp: number, body: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    Buffer.from(secret.slice("whsec_".length), "base64"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );

  return `v1,${Buffer.from(mac).toString("base64")}`;
};

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
      Effect.promise(() => signed(signer, id, at, JSON.stringify(body))),
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
          const stranger = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;

          const statuses = [
            (yield* posted(named, secret, "c1", 0, delivery)).status,
            (yield* posted(named, secret, "c1", 0, delivery)).status,
            (yield* posted(named, secret, "c2", 0, delivery, stranger)).status,
            (yield* posted(named, secret, "c3", 301, delivery)).status,
            (yield* posted(named, secret, "c4", -301, delivery)).status,
            (yield* posted(named, secret, "c5", 0, [delivery])).status,
            (yield* posted("?watch=ended", secret, "c6", 0, delivery)).status,
            (yield* posted("", secret, "c7", 0, delivery)).status,
          ];

          const challenge = yield* Effect.flatMap(
            posted(named, secret, "msg_verification_1", 0, {
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

        const full = (yield* posted(`?watch=${id}`, secret, "c1", 0, delivery)).status;

        room.left = true;

        const retried = (yield* posted(`?watch=${id}`, secret, "c1", 0, delivery)).status;

        expect([full, retried]).toEqual([503, 204]);
        expect(accepted).toEqual([delivery]);
      }).pipe(Effect.provide(client));
    }),
  );
});
