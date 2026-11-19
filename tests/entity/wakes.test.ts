import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import type { Duration } from "effect";
import {
  Context,
  DateTime,
  Deferred,
  Effect,
  ErrorReporter,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
} from "effect";
import { SingleRunner } from "effect/cluster";
import { Digest } from "effect/crypto";
import { HttpClient, HttpClientRequest } from "effect/http";
import { KeyValueStore } from "effect/persistence";
import { SqlClient } from "effect/sql";

import * as Authentication from "../../src/authentication/Authentication.js";
import * as Action from "../../src/contract/Action.js";
import * as Event from "../../src/contract/Event.js";
import { Wake } from "../../src/contract/wake.js";
import * as ActionEntity from "../../src/entity/ActionEntity.js";
import { makeWake } from "../../src/entity/wakes.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as Testing from "../../src/testing/Testing.js";
import * as Webhook from "../../src/webhook/Webhook.js";
import { verify } from "../support/app/authentication.js";
import { CurrentActor } from "../support/app/authorization.js";
import { eventually } from "../support/live.js";
import { recorder } from "../support/reporter.js";
import { unaryOf } from "../support/rpc.js";
import { Ticked } from "../support/ticked.js";
import { challengeIn, Login, secretOf } from "../support/webhook.js";

const Ticker = ActionEntity.make("Ticker", [Ticked], {
  authentication: Login,
  key: ({ room }) => room,
});

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

    const challenge = challengeIn(body);

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
        yield* eventually(() => deliveredIn(seen), "30 seconds");

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
    "keeps a failing delivery's retry wait across a restart that another call starts before it is due",
    () => {
      const { seen, tick, server } = makeWorld({
        accepts: () => false,
        maxIdleTime: "1 second",
      });

      return Effect.gen(function* () {
        yield* subscribed;
        yield* tick(1);
        yield* eventually(() => seen.attempts.length >= 5, "30 seconds");

        const first = seen.attempts[0]?.at ?? Number.NaN;
        const last = seen.attempts.at(-1)?.at ?? Number.NaN;

        yield* eventually(
          () => seen.stops.some((at) => at > last),
          "15 seconds"
        );

        const before = seen.attempts.length;
        const polled = yield* pollOf("a");
        const polledAt = Date.now();

        yield* eventually(() => seen.attempts.length > before, "30 seconds");

        const resumed = seen.attempts[before]?.at ?? Number.NaN;

        expect(polled.status).toBe(200);
        expect(polledAt).toBeLessThan(last + (last - first));
        expect(resumed - last).toBeGreaterThanOrEqual(last - first);
      }).pipe(Effect.scoped, Effect.provide(server));
    },
    { timeout: 90_000 }
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
        yield* eventually(() => deliveredIn(seen), "60 seconds");

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
    { timeout: 120_000 }
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
        yield* eventually(() => deliveredIn(seen), "15 seconds");
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
        yield* eventually(() => seen.attempts.length >= 1, "15 seconds");

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
        expect(apart.length).toBeGreaterThan(0);
        expect(Math.min(...apart)).toBeGreaterThanOrEqual(1000);
      }).pipe(Effect.scoped, Effect.provide(server));
    },
    { timeout: 60_000 }
  );
});

const Unkept = Authentication.make("wakes.Unkept", CurrentActor, {
  principal: (actor) => actor.id,
});

const UnkeptTicker = ActionEntity.make("UnkeptTicker", [Ticked], {
  authentication: Unkept,
  key: ({ room }) => room,
});

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

        const answered = yield* Effect.suspend(() =>
          unaryOf(
            tickers("a")["ticked/poll"]?.(
              { input: { room: "a" }, cursor: null },
              { headers: { authorization: "Bearer alice" } }
            ),
            "ticked/poll"
          )
        ).pipe(Effect.timeoutOption("5 seconds"));

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
        yield* eventually(() => occurrencesOf(seen).length > 0, "15 seconds");
        yield* Effect.sleep("1 second");

        const other = yield* pollOf("a");

        yield* tick(2);
        yield* eventually(() => occurrencesOf(seen).length > 1, "15 seconds");
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

const Remind = Action.make("remind", {
  description: "Wake the alarm a while from now.",
  input: {
    alarm: Schema.String,
    inMs: Schema.Int,
    rollBack: Schema.optional(Schema.Boolean),
  },
  success: { at: Schema.Int },
  readOnly: false,
  caller: Action.Anyone,
});

const Alarm = ActionEntity.make("Alarm", [Remind], {
  key: ({ alarm }) => alarm,
});

const reminding = Action.implement(
  [Remind],
  Effect.map(SqlClient.SqlClient, (sql) => ({
    remind: ({ inMs, rollBack }) =>
      Effect.gen(function* () {
        const at = DateTime.add(yield* DateTime.now, { milliseconds: inMs });
        const waking = ActionEntity.wakeAt(at);

        yield* rollBack === true
          ? Effect.ignore(
              sql.withTransaction(
                Effect.andThen(waking, Effect.fail("rolled back"))
              ),
              { log: false }
            )
          : waking;

        return { at: DateTime.toEpochMillis(at) };
      }),
  }))
);

interface Woken {
  readonly at: number;
  readonly build: number;
  readonly runtime: number;
}

const makeAlarms = (maxIdleTime?: Duration.Input) => {
  const seen = {
    builds: 0,
    runtime: 1,
    holding: false,
    stops: [] as number[],
    woken: [] as Woken[],
  };

  const services = Layer.effectDiscard(
    Effect.acquireRelease(
      Effect.sync(() => {
        seen.builds += 1;
      }),
      () =>
        Effect.sync(() => {
          seen.stops.push(Date.now());
        })
    )
  );

  const entities = ActionEntity.layer(Alarm, reminding, {
    services,
    maxIdleTime,
    onWake: (at) =>
      Effect.suspend(() => {
        seen.woken.push({
          at: DateTime.toEpochMillis(at),
          build: seen.builds,
          runtime: seen.runtime,
        });

        return seen.runtime === 1 && seen.holding ? Effect.never : Effect.void;
      }),
  }).pipe(Layer.provideMerge(runner));

  return { seen, entities };
};

const remind = (alarm: string, inMs: number, rollBack?: boolean) =>
  Effect.flatMap(ActionEntity.client(Alarm), (alarms) =>
    alarms.remind(
      rollBack === undefined ? { alarm, inMs } : { alarm, inMs, rollBack }
    )
  );

describe("ActionEntity.wakeAt", () => {
  it.live(
    "runs onWake at its time in an activation built again for it, the one that asked having been stopped",
    () => {
      const { seen, entities } = makeAlarms("1 second");

      return Effect.gen(function* () {
        const { at } = yield* remind("a", 8000);

        yield* eventually(() => seen.woken.length > 0, "15 seconds");

        const wokenAt = Date.now();

        expect(seen.woken).toStrictEqual([{ at, build: 2, runtime: 1 }]);
        expect(seen.stops.some((stop) => stop < at)).toBe(true);
        expect(wokenAt).toBeGreaterThanOrEqual(at);
      }).pipe(
        Effect.scoped,
        Effect.provide(entities.pipe(Layer.provideMerge(database)))
      );
    },
    { timeout: 30_000 }
  );

  it.live(
    "runs onWake again in the next runtime where the runtime running it stopped, the wake stored with the runtime's messages",
    () =>
      Effect.gen(function* () {
        const shared = Layer.succeedContext(yield* Layer.build(database));
        const { seen, entities } = makeAlarms();
        const served = entities.pipe(Layer.provideMerge(shared));

        seen.holding = true;

        const { at } = yield* Effect.gen(function* () {
          const reminded = yield* remind("a", 1500);

          yield* eventually(() => seen.woken.length > 0, "15 seconds");

          return reminded;
        }).pipe(Effect.scoped, Effect.provide(served));

        seen.runtime = 2;

        yield* eventually(() => seen.woken.length > 1, "15 seconds").pipe(
          Effect.scoped,
          Effect.provide(served)
        );

        expect(seen.woken).toStrictEqual([
          { at, build: 1, runtime: 1 },
          { at, build: 2, runtime: 2 },
        ]);
      }).pipe(Effect.scoped),
    { timeout: 30_000 }
  );

  it.live(
    "keeps the earliest wake: a later time sends nothing while an earlier one is pending, and an earlier time sends its own",
    () => {
      const { entities } = makeAlarms();

      return Effect.gen(function* () {
        yield* remind("a", 20_000);
        const first = yield* pendingWakes;

        yield* remind("a", 30_000);
        const later = yield* pendingWakes;

        yield* remind("a", 10_000);
        const earlier = yield* pendingWakes;

        expect([first, later, earlier]).toStrictEqual([1, 1, 2]);
      }).pipe(
        Effect.scoped,
        Effect.provide(entities.pipe(Layer.provideMerge(database)))
      );
    },
    { timeout: 30_000 }
  );
});

describe("ActionEntity.wakeAt in an entity", () => {
  it.live(
    "refuses a wake asked for inside a SQL transaction, so its rollback leaves nothing pending that a later wake would defer to",
    () => {
      const { entities } = makeAlarms();

      return Effect.gen(function* () {
        const refused = yield* Effect.exit(remind("a", 20_000, true));
        const rolledBack = yield* pendingWakes;

        yield* remind("a", 30_000);
        const after = yield* pendingWakes;

        expect(Exit.isFailure(refused)).toBe(true);
        expect([rolledBack, after]).toStrictEqual([0, 1]);
      }).pipe(
        Effect.scoped,
        Effect.provide(entities.pipe(Layer.provideMerge(database)))
      );
    },
    { timeout: 30_000 }
  );

  it.live(
    "reports onWake's failure to the reporters the activation's services provide",
    () => {
      const reports: string[] = [];

      const entities = ActionEntity.layer(Alarm, reminding, {
        services: ErrorReporter.layer([recorder(reports)]),
        onWake: () => Effect.fail("the wake failed"),
      }).pipe(Layer.provideMerge(runner));

      return Effect.gen(function* () {
        yield* remind("a", 0);
        yield* eventually(() => reports.length > 0, "15 seconds");

        expect(reports.join("\n")).toContain("the wake failed");
      }).pipe(
        Effect.scoped,
        Effect.provide(entities.pipe(Layer.provideMerge(database)))
      );
    },
    { timeout: 30_000 }
  );
});

const sending = Effect.fnUntraced(function* () {
  const sent: number[] = [];
  const stored = yield* Deferred.make<undefined>();
  const acknowledged = yield* Deferred.make<undefined>();

  const made = yield* makeWake(({ at }) =>
    Effect.suspend(() => {
      sent.push(at);

      return sent.length === 1
        ? Effect.andThen(
            Deferred.succeed(stored, undefined),
            Deferred.await(acknowledged)
          )
        : Effect.void;
    })
  );

  return { ...made, sent, stored, acknowledged };
});

describe("An entity's wake in an activation", () => {
  it.effect(
    "stores a wait's own deadline before it waits, so an earlier wake firing hands it nothing, and ends at a wake due no earlier, a stale one aside",
    () =>
      Effect.gen(function* () {
        const sent: number[] = [];

        const { wake, woke } = yield* makeWake(({ at }) =>
          Effect.sync(() => {
            sent.push(at);
          })
        );

        yield* wake.wakeAt(3000);

        const waiting = yield* Effect.forkChild(wake.until(5000));

        yield* Effect.yieldNow;

        const stored = [...sent];

        yield* woke(1000);
        yield* woke(3000);
        yield* Effect.yieldNow;

        const afterEarlier = [...sent];
        const runningAfterEarlier = waiting.pollUnsafe() === undefined;

        yield* woke(5000);
        yield* Fiber.join(waiting);

        expect(stored).toStrictEqual([3000, 5000]);
        expect(afterEarlier).toStrictEqual([3000, 5000]);
        expect(runningAfterEarlier).toBe(true);
      })
  );

  it.effect(
    "forgets a wake delivered before its send was acknowledged, so a later time is sent",
    () =>
      Effect.gen(function* () {
        const { wake, woke, sent, stored, acknowledged } = yield* sending();

        const first = yield* Effect.forkChild(wake.wakeAt(1000));

        yield* Deferred.await(stored);

        const delivered = yield* Effect.forkChild(woke(1000));

        yield* Effect.yieldNow;
        yield* Deferred.succeed(acknowledged, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(delivered);
        yield* wake.wakeAt(61_000);

        expect(sent).toStrictEqual([1000, 61_000]);
      })
  );

  it.effect(
    "records a wake whose send was interrupted after it was stored, so the same time is not sent twice",
    () =>
      Effect.gen(function* () {
        const { wake, sent, stored, acknowledged } = yield* sending();

        const first = yield* Effect.forkChild(wake.wakeAt(1000));

        yield* Deferred.await(stored);

        const interrupting = yield* Effect.forkChild(Fiber.interrupt(first));

        yield* Effect.yieldNow;
        yield* Deferred.succeed(acknowledged, undefined);
        yield* Fiber.join(interrupting);
        yield* wake.wakeAt(1000);

        expect(sent).toStrictEqual([1000]);
      })
  );

  it.effect("rounds a time between milliseconds up to the next one", () =>
    Effect.gen(function* () {
      const sent: number[] = [];

      const { wake } = yield* makeWake(({ at }) =>
        Effect.sync(() => {
          sent.push(at);
        })
      );

      yield* ActionEntity.wakeAt(
        DateTime.addDuration(DateTime.makeUnsafe(1000), "500 micros")
      ).pipe(Effect.provideService(Wake, wake));

      expect(sent).toStrictEqual([1001]);
    })
  );
});
