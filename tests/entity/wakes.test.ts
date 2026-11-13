import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Clock, Effect, Layer, Schedule, Schema } from "effect";
import { SingleRunner } from "effect/cluster";
import { Digest } from "effect/crypto";
import { HttpClient, HttpClientRequest } from "effect/http";
import { KeyValueStore } from "effect/persistence";
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

const makeWorld = () => {
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
            nextPoll: "1 second",
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

  const sql = Layer.orDie(SqliteClient.layer({ filename: ":memory:" }));

  const runner = SingleRunner.layer({
    shardingConfig: { entityMessagePollInterval: "250 millis" },
    runnerStorage: "memory",
  }).pipe(Layer.orDie, Layer.provide(Digest.layerWebCrypto));

  const entities = ActionEntity.layer(Ticker, ticking, {
    services: Webhook.layer({ persist: true, resolveCallbacks: false }).pipe(
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
    server: edge.pipe(Layer.provideMerge(entities), Layer.provideMerge(sql)),
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

const subscribeTo = (room: string) =>
  HttpClient.execute(
    HttpClientRequest.post("/api/events/ticked/subscribe").pipe(
      asAlice,
      HttpClientRequest.bodyJsonUnsafe({
        input: { room },
        delivery: {
          url: "https://hooks.example.com/alice",
          secret: secretOf(1),
        },
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

        seen.accepting = true;

        yield* until(
          Effect.sync(() => delivered.length),
          (count) => count > 0,
          25_000
        );

        expect(answered.status).toBe(200);
        expect(pendingAtStop).toBe(1);
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

describe("Webhook.layer with persist in an entity's services", () => {
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
