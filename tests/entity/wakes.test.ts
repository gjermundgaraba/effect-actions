import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import type { Duration } from "effect";
import { Context, Effect, Layer, Option, Schedule, Schema } from "effect";
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
import { Ticked } from "../support/ticked.js";
import { Login, secretOf } from "../support/webhook.js";

const Ticker = ActionEntity.make(
  "Ticker",
  ActionRpc.make([Ticked], { authentication: Login }),
  { key: { ticked: ({ room }) => room } }
);

const TickerHttp = ActionHttp.make([Ticked], { authentication: Login });

const signIn = Authentication.layer(Login, verify);

const database = Layer.orDie(SqliteClient.layer({ filename: ":memory:" }));

const runner = SingleRunner.layer({
  shardingConfig: { entityMessagePollInterval: "250 millis" },
  runnerStorage: "memory",
}).pipe(Layer.orDie, Layer.provide(Digest.layerWebCrypto));

class Ticks extends Context.Service<Ticks, readonly number[]>()(
  "test/wakes/Ticks"
) {}

interface Attempt {
  readonly at: number;
  readonly status: number;
  readonly body: string;
}

interface Seen {
  builds: number;
  readonly stops: number[];
  readonly attempts: Attempt[];
}

const makeWorld = ({
  accepts = () => true,
  maxIdleTime,
}: {
  readonly accepts?: (seen: Seen) => boolean;
  readonly maxIdleTime?: Duration.Input;
} = {}) => {
  const ticks: number[] = [];
  const seen: Seen = { builds: 0, stops: [], attempts: [] };

  const ticking = Event.implement(
    Ticked,
    Effect.as(
      Effect.acquireRelease(
        Effect.sync(() => {
          seen.builds += 1;
        }),
        () =>
          Effect.sync(() => {
            seen.stops.push(Date.now());
          })
      ),
      {
        notified: true,
        check: (_input: { readonly room: string }, cursor: string | null) =>
          Effect.map(Ticks, (held) => ({
            cursor: String(held.length),
            events: held
              .slice(cursor === null ? held.length : Number(cursor))
              .map((at) => ({ eventId: `tick-${at}`, data: { at } })),
          })),
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

    const status = accepts(seen) ? 200 : 503;

    seen.attempts.push({ at: Date.now(), status, body });

    return new Response(null, { status });
  };

  const services = Layer.merge(
    Webhook.layer({ persist: true, resolveCallbacks: false }).pipe(
      Layer.provide(Testing.layer(receiver))
    ),
    Layer.succeed(Ticks)(ticks)
  );

  const entities = ActionEntity.layer(Ticker, ticking, {
    services,
    maxIdleTime,
  }).pipe(
    Layer.provideMerge(runner),
    Layer.provide([signIn, KeyValueStore.layerSql()]),
    Layer.provideMerge(Event.layerMemory)
  );

  const edge = Testing.layer(
    ActionHttp.layer(TickerHttp, ActionEntity.reaching(Ticker)).pipe(
      Layer.provide(signIn)
    )
  );

  const tick = (at: number) =>
    Effect.andThen(
      Effect.sync(() => ticks.push(at)),
      Effect.flatMap(Event.Events, (events) => events.notify(Ticked))
    );

  return {
    seen,
    tick,
    server: edge.pipe(
      Layer.provideMerge(entities),
      Layer.provideMerge(database)
    ),
  };
};

const bodyOf = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

const Stored = Schema.Array(
  Schema.Struct({
    headers: Schema.NullOr(Schema.String),
    payload: Schema.String,
    deliver_at: Schema.Int,
  })
);

const pendingWakes = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql`SELECT COUNT(*) AS pending FROM cluster_messages WHERE tag = 'effect-actions/wake' AND processed = 0`.pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.Tuple([Schema.Struct({ pending: Schema.Int })])
      )
    ),
    Effect.map(([{ pending }]) => pending)
  )
).pipe(Effect.orDie);

const storedWakes = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql`SELECT headers, payload, deliver_at FROM cluster_messages WHERE tag = 'effect-actions/wake'`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Stored))
  )
).pipe(Effect.orDie);

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

const deliveredIn = ({ attempts }: Seen) =>
  attempts.some(({ status }) => status === 200);

const lastWait = Effect.fnUntraced(function* ({ attempts, stops }: Seen) {
  const delivered = attempts.findIndex(({ status }) => status === 200);
  const cut = attempts[delivered - 1]?.at ?? Number.NaN;
  const ended = attempts[delivered]?.at ?? Number.NaN;

  const due = Math.min(
    ...(yield* storedWakes)
      .map(({ deliver_at }) => deliver_at)
      .filter((at) => at > cut)
  );

  return {
    ms: due - cut,
    stoppedWithin: stops.some((at) => cut < at && at < ended),
  };
});

const occurrencesOf = ({ attempts }: Seen) =>
  attempts
    .filter(({ status }) => status === 200)
    .map(({ body }) => bodyOf(body));

describe("A webhook retry wait in an entity on a SQL runner", () => {
  it.live(
    "delivers after a retry wait of a few seconds the reaper cut, its wake building the stopped entity again though nothing calls it meanwhile",
    () => {
      const { seen, tick, server } = makeWorld({
        accepts: ({ stops }) => stops.length > 0,
        maxIdleTime: "1 second",
      });

      return Effect.gen(function* () {
        const answered = yield* subscribed;

        yield* tick(1);
        yield* until(
          Effect.sync(() => deliveredIn(seen)),
          Boolean,
          30_000
        );

        const wait = yield* lastWait(seen);

        expect(answered.status).toBe(200);
        expect(wait.ms).toBeLessThan(10_000);
        expect(wait.stoppedWithin).toBe(true);
        expect(seen.builds).toBe(2);
        expect(occurrencesOf(seen)).toMatchObject([
          { eventId: "tick-1", name: "ticked", data: { at: 1 } },
        ]);
      }).pipe(Effect.scoped, Effect.provide(server));
    },
    { timeout: 60_000 }
  );

  it.live(
    "delivers after growing retry waits the reaper cut again and again, each wake building the entity anew, and keeps no credential in its stored wakes",
    () => {
      const { seen, tick, server } = makeWorld({
        accepts: ({ stops }) => stops.length >= 2,
        maxIdleTime: "1 second",
      });

      return Effect.gen(function* () {
        const answered = yield* subscribed;

        yield* tick(1);
        yield* until(
          Effect.sync(() => deliveredIn(seen)),
          Boolean,
          45_000
        );

        const wait = yield* lastWait(seen);
        const wakes = yield* storedWakes;
        const attempts = seen.attempts.map(({ at }) => at);

        const apart = attempts
          .slice(1)
          .map((at, index) => at - (attempts[index] ?? at));

        expect(answered.status).toBe(200);
        expect(seen.stops.length).toBeGreaterThanOrEqual(2);
        expect(seen.builds).toBeGreaterThanOrEqual(3);
        expect(wait.stoppedWithin).toBe(true);
        expect(apart.at(-1)).toBeGreaterThan(2 * (apart[0] ?? Infinity));
        expect(wakes).not.toStrictEqual([]);
        expect(
          wakes.filter(({ headers, payload }) =>
            /authorization|alice/iu.test(`${headers ?? ""} ${payload}`)
          )
        ).toStrictEqual([]);
        expect(occurrencesOf(seen)).toMatchObject([
          { eventId: "tick-1", name: "ticked", data: { at: 1 } },
        ]);
      }).pipe(Effect.scoped, Effect.provide(server));
    },
    { timeout: 60_000 }
  );

  it.live(
    "writes no wake for a subscription that delivers, however often it is refreshed, its expiry included",
    () => {
      const { seen, tick, server } = makeWorld();

      return Effect.gen(function* () {
        const answers = yield* Effect.forEach(Array.from({ length: 5 }), () =>
          Effect.map(subscribed, ({ status }) => status)
        );

        yield* tick(1);
        yield* until(
          Effect.sync(() => deliveredIn(seen)),
          Boolean,
          15_000
        );
        yield* Effect.sleep("1 second");

        expect(answers).toStrictEqual([200, 200, 200, 200, 200]);
        expect(yield* storedWakes).toStrictEqual([]);
      }).pipe(Effect.scoped, Effect.provide(server));
    },
    { timeout: 60_000 }
  );
});

describe("A failing webhook subscription in an entity, refreshed while it waits to retry", () => {
  it.live(
    "keeps one wake pending and POSTs only at its retries, however often it is refreshed",
    () => {
      const { seen, tick, server } = makeWorld({ accepts: () => false });

      return Effect.gen(function* () {
        yield* subscribed;
        yield* tick(1);
        yield* until(
          Effect.sync(() => seen.attempts.length),
          (attempts) => attempts >= 1,
          15_000
        );

        const pending = yield* Effect.forEach(Array.from({ length: 20 }), () =>
          Effect.andThen(
            Effect.andThen(subscribed, Effect.sleep("100 millis")),
            pendingWakes
          )
        );

        const attempts = seen.attempts.map(({ at }) => at);

        const apart = attempts
          .slice(1)
          .map((at, index) => at - (attempts[index] ?? at));

        expect(Math.max(...pending)).toBeLessThanOrEqual(1);
        expect(Math.min(...apart)).toBeGreaterThanOrEqual(1000);
      }).pipe(Effect.scoped, Effect.provide(server));
    },
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
    "dies at each activation where the authentication names no schema, so a call to the entity waits while Effect's runner builds it again",
    () => {
      const builds = { count: 0 };

      const ticking = Event.implement(
        Ticked,
        Effect.as(
          Effect.sync(() => {
            builds.count += 1;
          }),
          {
            notified: true,
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
      const { seen, tick, server } = makeWorld();

      return Effect.gen(function* () {
        yield* subscribeTo("a/x");
        yield* tick(1);
        yield* until(
          Effect.sync(() => occurrencesOf(seen).length),
          (count) => count > 0,
          15_000
        );
        yield* Effect.sleep("1 second");

        const other = yield* pollOf("a");

        yield* tick(2);
        yield* until(
          Effect.sync(() => occurrencesOf(seen).length),
          (count) => count > 1,
          15_000
        );
        yield* Effect.sleep("3 seconds");

        expect(other.status).toBe(200);
        expect(seen.builds).toBe(2);
        expect(occurrencesOf(seen)).toMatchObject([
          { eventId: "tick-1" },
          { eventId: "tick-2" },
        ]);
      }).pipe(Effect.scoped, Effect.provide(server));
    },
    { timeout: 60_000 }
  );
});
