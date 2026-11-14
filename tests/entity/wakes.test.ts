import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Clock,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Schedule,
  Schema,
} from "effect";
import { SingleRunner } from "effect/cluster";
import type { Entity } from "effect/cluster";
import { Digest } from "effect/crypto";
import { HttpClient, HttpClientRequest } from "effect/http";
import { KeyValueStore } from "effect/persistence";
import { Rpc, RpcGroup } from "effect/rpc";
import { SqlClient } from "effect/sql";

import * as Authentication from "../../src/authentication/Authentication.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionEntity from "../../src/entity/ActionEntity.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import * as Testing from "../../src/testing/Testing.js";
import * as Webhook from "../../src/webhook/Webhook.js";
import { verify } from "../support/app/authentication.js";
import { CurrentActor } from "../support/app/authorization.js";
import { Login, secretOf } from "../support/webhook.js";

const Ticked = Event.make("ticked", {
  description: "A room ticked.",
  input: { room: Schema.String },
  payload: { at: Schema.Int },
  caller: CurrentActor,
});

const Ticker = ActionEntity.make(
  "Ticker",
  ActionRpc.make([Ticked], { authentication: Login }),
  { key: { ticked: ({ room }) => room } }
);

const TickerHttp = ActionHttp.make([Ticked], { authentication: Login });

const signIn = Authentication.layer(Login, verify);

const Count = Schema.Array(Schema.Struct({ count: Schema.Int }));

const database = Layer.orDie(SqliteClient.layer({ filename: ":memory:" }));

const runner = SingleRunner.layer({
  shardingConfig: { entityMessagePollInterval: "250 millis" },
  runnerStorage: "memory",
}).pipe(Layer.orDie, Layer.provide(Digest.layerWebCrypto));

const makeWorld = ({
  nextPoll = "1 second",
  maxTtl,
}: {
  readonly nextPoll?: Duration.Input;
  readonly maxTtl?: Duration.Input;
} = {}) => {
  const ticks: number[] = [];
  const seen = { builds: 0, stops: 0, accepting: false };
  const delivered: string[] = [];

  const ticking = Event.implement(
    Ticked,
    Effect.as(
      Effect.acquireRelease(
        Effect.sync(() => {
          seen.builds += 1;
        }),
        () =>
          Effect.sync(() => {
            seen.stops += 1;
          })
      ),
      {
        check: (_input: { readonly room: string }, cursor: string | null) =>
          Effect.succeed({
            cursor: String(ticks.length),
            events: ticks
              .slice(cursor === null ? ticks.length : Number(cursor))
              .map((at) => ({ eventId: `tick-${at}`, data: { at } })),
            nextPoll,
          }),
      }
    ),
    { authorize: Event.allowAll }
  );

  const receiver = async (request: Request) => {
    const body = await request.text();

    const challenge = /"challenge":"(?<challenge>[^"]+)"/u.exec(body)?.groups?.[
      "challenge"
    ];

    if (challenge !== undefined) {
      return Response.json({ challenge });
    }

    if (!seen.accepting) {
      return new Response(null, { status: 503 });
    }

    delivered.push(body);

    return new Response(null, { status: 200 });
  };

  const entities = ActionEntity.layer(Ticker, ticking, {
    services: Webhook.layer({
      persist: true,
      resolveCallbacks: false,
      maxTtl,
    }).pipe(
      Layer.provide(ActionEntity.layerClock),
      Layer.provide(Testing.layer(receiver))
    ),
    maxIdleTime: "5 seconds",
  }).pipe(
    Layer.provideMerge(runner),
    Layer.provide([signIn, Event.layerMemory, KeyValueStore.layerSql()])
  );

  const edge = Testing.layer(
    ActionHttp.layer(TickerHttp, ActionEntity.reaching(Ticker)).pipe(
      Layer.provide(signIn)
    )
  );

  return {
    ticks,
    seen,
    delivered,
    server: edge.pipe(
      Layer.provideMerge(entities),
      Layer.provideMerge(database)
    ),
  };
};

const bodyOf = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const wakesBefore = (dueBefore: number, unprocessedOnly: boolean) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`SELECT count(*) AS count FROM cluster_messages WHERE tag = 'effect-actions/wake' AND deliver_at < ${dueBefore} AND (processed = 0 OR ${unprocessedOnly ? 0 : 1} = 1)`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Count)),
      Effect.map((rows) => rows[0]?.count ?? 0)
    )
  ).pipe(Effect.orDie);

const Stored = Schema.Array(
  Schema.Struct({
    headers: Schema.NullOr(Schema.String),
    payload: Schema.String,
  })
);

const storedWakes = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql`SELECT headers, payload FROM cluster_messages WHERE tag = 'effect-actions/wake'`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Stored))
  )
).pipe(Effect.orDie);

const pendingWakes = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql`SELECT count(*) AS count FROM cluster_messages WHERE tag = 'effect-actions/wake' AND processed = 0`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Count)),
    Effect.map((rows) => rows[0]?.count ?? 0)
  )
).pipe(Effect.orDie);

const retryWakes = Effect.suspend(() => wakesBefore(Date.now() + 60_000, true));

const until = <A, E, R>(
  check: Effect.Effect<A, E, R>,
  done: (value: A) => boolean,
  within: number
) =>
  check.pipe(
    Effect.repeat({ until: done, schedule: Schedule.spaced("200 millis") }),
    Effect.timeoutOrElse({
      duration: within,
      orElse: () =>
        Effect.die(new Error(`Never held within ${String(within)} ms`)),
    })
  );

const asAlice = HttpClientRequest.setHeaders({ authorization: "Bearer alice" });

const subscribeTo = (room: string, ttlMs?: number) =>
  HttpClient.execute(
    HttpClientRequest.post("/api/events/ticked/subscribe").pipe(
      asAlice,
      HttpClientRequest.bodyJsonUnsafe({
        input: { room },
        delivery: {
          url: "https://hooks.example.com/alice",
          secret: secretOf(1),
        },
        ttlMs,
      })
    )
  );

const subscribed = subscribeTo("a");

const pollOf = (room: string) =>
  HttpClient.execute(
    HttpClientRequest.post("/api/events/ticked").pipe(
      asAlice,
      HttpClientRequest.bodyJsonUnsafe({ input: { room } })
    )
  );

const polled = pollOf("a");

describe("ActionEntity.layerClock on a SQL runner", () => {
  it.live(
    "keeps a webhook delivery's long retry wait as a persisted wake, which builds the entity again after the reaper stopped it and delivers",
    () => {
      const { ticks, seen, delivered, server } = makeWorld();

      return Effect.gen(function* () {
        const started = Date.now();
        const answered = yield* subscribed;

        ticks.push(1);

        yield* until(
          Effect.andThen(polled, retryWakes),
          (pending) => pending > 0,
          25_000
        );

        yield* until(
          Effect.sync(() => seen.stops),
          (stops) => stops > 0,
          15_000
        );

        const pendingAtStop = yield* retryWakes;
        const wakesAtStop = yield* storedWakes;

        seen.accepting = true;

        yield* until(
          Effect.sync(() => delivered.length),
          (count) => count > 0,
          25_000
        );

        expect(answered.status).toBe(200);
        expect(pendingAtStop).toBe(1);
        expect(wakesAtStop).not.toStrictEqual([]);
        expect(
          wakesAtStop.filter(({ headers, payload }) =>
            /authorization|alice/iu.test(`${headers ?? ""} ${payload}`)
          )
        ).toStrictEqual([]);
        expect(yield* wakesBefore(started + 60_000, false)).toBe(1);
        expect(seen.builds).toBe(2);
        expect(delivered.map((body) => bodyOf(body))).toMatchObject([
          { eventId: "tick-1", name: "ticked", data: { at: 1 } },
        ]);
      }).pipe(Effect.scoped, Effect.provide(server));
    },
    { timeout: 90_000 }
  );

  it.live(
    "ends a long wait in the activation that sent its wake, the clock the application provides around the runner notwithstanding",
    () => {
      const { ticks, seen, delivered, server } = makeWorld();

      return Effect.gen(function* () {
        const answered = yield* subscribed;

        ticks.push(1);

        yield* until(
          Effect.andThen(polled, retryWakes),
          (pending) => pending > 0,
          25_000
        );

        seen.accepting = true;

        yield* until(
          Effect.andThen(
            polled,
            Effect.sync(() => delivered.length)
          ),
          (count) => count > 0,
          25_000
        );

        expect(answered.status).toBe(200);
        expect(yield* retryWakes).toBe(0);
        expect(seen).toMatchObject({ builds: 1, stops: 0 });
        expect(delivered.map((body) => bodyOf(body))).toMatchObject([
          { eventId: "tick-1", name: "ticked", data: { at: 1 } },
        ]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          server.pipe(
            Layer.provide(
              Layer.effect(Clock.Clock)(Effect.service(Clock.Clock))
            )
          )
        )
      );
    },
    { timeout: 90_000 }
  );
});

describe("ActionEntity.layerClock's rows", () => {
  it.live(
    "keeps at most 16 wakes pending due within 16 seconds and 16 more for each doubling beyond, however many times a subscription is refreshed to expire at another time",
    () => {
      const longest = 30 * 24 * 60 * 60 * 1000;
      const refreshes = 400;
      const { server } = makeWorld({ maxTtl: longest });

      const bound = 16 * (Math.floor(Math.log2(longest / 16_000)) + 2);

      return Effect.gen(function* () {
        yield* subscribed;

        const granted = yield* until(pendingWakes, (count) => count > 0, 5000);

        for (let refresh = 0; refresh < refreshes; refresh += 1) {
          yield* subscribeTo(
            "a",
            longest - refresh * Math.floor((longest - 60_000) / refreshes)
          );
        }

        yield* Effect.sleep("2 seconds");

        expect(granted).toBe(1);
        expect(refreshes).toBeGreaterThan(bound);
        expect(yield* pendingWakes).toBeGreaterThan(0);
        expect(yield* pendingWakes).toBeLessThanOrEqual(bound);
      }).pipe(Effect.scoped, Effect.provide(server));
    },
    { timeout: 120_000 }
  );

  it.live(
    "asks a check source whose nextPoll is 10 seconds or more again through a wake",
    () => {
      const { server } = makeWorld({ nextPoll: "10 seconds" });

      return Effect.gen(function* () {
        yield* subscribed;

        const polls = yield* Effect.suspend(() =>
          wakesBefore(Date.now() + 60_000, false)
        ).pipe(
          Effect.repeat({
            until: (count) => count > 1,
            schedule: Schedule.spaced("200 millis").pipe(
              Schedule.upTo({ duration: "35 seconds" })
            ),
          })
        );

        expect(polls).toBeGreaterThan(1);
      }).pipe(Effect.scoped, Effect.provide(server));
    },
    { timeout: 60_000 }
  );
});

const Naps = RpcGroup.make(
  Rpc.make("nap", { payload: { until: Schema.Int }, success: Schema.Int })
);

const Napper = ActionEntity.make(
  "Napper",
  ActionRpc.make([Ticked], { authentication: Login }),
  { key: { ticked: ({ room }) => room }, rpcs: Naps }
);

const napping = ActionEntity.layer(
  Napper,
  Event.implement(
    Ticked,
    { check: () => Effect.succeed({ cursor: "0", events: [] }) },
    { authorize: Event.allowAll }
  ),
  {
    services: ActionEntity.layerClock,
    rpcs: {
      nap: ({ payload: { until: due } }) =>
        Effect.gen(function* () {
          yield* Effect.sleep(
            Duration.millis(due - (yield* Clock.currentTimeMillis))
          );

          return (yield* Clock.currentTimeMillis) - due;
        }),
    } satisfies Entity.HandlersFrom<RpcGroup.Rpcs<typeof Naps>>,
  }
).pipe(
  Layer.provideMerge(runner),
  Layer.provideMerge(database),
  Layer.provide([signIn, Event.layerMemory])
);

const napUntil = (due: number) =>
  Effect.flatMap(Napper.client, (nappers) => nappers("n").nap({ until: due }));

describe("ActionEntity.layerClock in an entity's services", () => {
  it.live(
    "ends a handler's sleep of 10 seconds or more at its end, not at its wake 900 milliseconds before, though the wake comes while the handler holds the entity's one slot",
    () =>
      Effect.gen(function* () {
        const late = yield* napUntil(
          Math.ceil(Date.now() / 1000) * 1000 + 12_900
        ).pipe(Effect.timeout("30 seconds"));

        expect(late).toBeGreaterThan(-100);
        expect(yield* wakesBefore(Date.now(), false)).toBeGreaterThan(0);
      }).pipe(Effect.provide(napping)),
    { timeout: 60_000 }
  );

  it.live(
    "ends a sleep at once when its wake is delivered before its time, as a test moving its deliver_at does",
    () =>
      Effect.gen(function* () {
        const napped = yield* Effect.forkScoped(napUntil(Date.now() + 60_000));

        yield* until(pendingWakes, (pending) => pending > 0, 10_000);
        yield* Effect.flatMap(
          SqlClient.SqlClient,
          (client) =>
            client`UPDATE cluster_messages SET deliver_at = ${Date.now()} WHERE tag = 'effect-actions/wake' AND processed = 0`
        ).pipe(Effect.orDie);

        const late = yield* Fiber.join(napped).pipe(
          Effect.timeout("20 seconds")
        );

        expect(late).toBeLessThan(-30_000);
      }).pipe(Effect.scoped, Effect.provide(napping)),
    { timeout: 60_000 }
  );
});

const Unkept = Authentication.make("wakes.Unkept", CurrentActor, {
  principal: (actor) => actor.id,
});

const UnkeptTicker = ActionEntity.make(
  "UnkeptTicker",
  ActionRpc.make([Ticked], { authentication: Unkept }),
  { key: { ticked: ({ room }) => room } }
);

describe("Webhook.layer with persist in an entity's services", () => {
  it.live(
    "dies at each activation where the authentication names a principal and no schema, so a call to the entity waits while Effect's runner builds it again",
    () => {
      const builds = { count: 0 };

      const ticking = Event.implement(
        Ticked,
        Effect.as(
          Effect.sync(() => {
            builds.count += 1;
          }),
          {
            check: () => Effect.succeed({ cursor: "0", events: [] }),
          }
        ),
        { authorize: Event.allowAll }
      );

      const server = ActionEntity.layer(UnkeptTicker, ticking, {
        services: Webhook.layer({
          persist: true,
          resolveCallbacks: false,
        }).pipe(
          Layer.provide(
            Testing.layer(async () => await Promise.resolve(new Response(null)))
          )
        ),
      }).pipe(
        Layer.provideMerge(runner),
        Layer.provide([
          Authentication.layer(Unkept, verify),
          Event.layerMemory,
          KeyValueStore.layerSql(),
        ]),
        Layer.provideMerge(database)
      );

      return Effect.gen(function* () {
        const tickers = yield* UnkeptTicker.client;

        const answered = yield* Effect.suspend(() => {
          const answer = tickers("a")["ticked/poll"]?.(
            { input: { room: "a" }, cursor: null },
            { headers: { authorization: "Bearer alice" } }
          );

          return answer !== undefined && Effect.isEffect(answer)
            ? answer
            : Effect.die(new Error("no unary rpc ticked"));
        }).pipe(Effect.timeoutOption("5 seconds"));

        expect(Option.isNone(answered)).toBe(true);
        expect(builds.count).toBeGreaterThan(1);
      }).pipe(Effect.scoped, Effect.provide(server));
    },
    { timeout: 30_000 }
  );

  it.live(
    "restores, as an entity id activates, only the subscriptions that entity id holds, though every entity shares one store and one id begins another's",
    () => {
      const { ticks, seen, delivered, server } = makeWorld();

      seen.accepting = true;

      return Effect.gen(function* () {
        yield* subscribeTo("a/x");

        ticks.push(1);

        yield* until(
          Effect.andThen(
            pollOf("a/x"),
            Effect.sync(() => delivered.length)
          ),
          (count) => count > 0,
          15_000
        );

        yield* Effect.sleep("1 second");

        const other = yield* pollOf("a");

        ticks.push(2);

        yield* until(
          Effect.sync(() => delivered.length),
          (count) => count > 1,
          15_000
        );

        yield* Effect.sleep("3 seconds");

        expect(other.status).toBe(200);
        expect(seen.builds).toBe(2);
        expect(delivered.map((body) => bodyOf(body))).toMatchObject([
          { eventId: "tick-1" },
          { eventId: "tick-2" },
        ]);
      }).pipe(Effect.scoped, Effect.provide(server));
    },
    { timeout: 60_000 }
  );
});
