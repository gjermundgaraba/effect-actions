import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import * as Persisted from "@gjermundgaraba/effect-actions/Persisted";
import {
  Context,
  DateTime,
  Effect,
  Exit,
  Fiber,
  Layer,
  Match,
  Schema,
  Scope,
  Stream,
} from "effect";
import { KeyValueStore } from "effect/persistence";
import { SqlClient, Statement } from "effect/sql";
import { TestClock } from "effect/testing";

import { sqlStorage } from "../../src/contract/event-tables.js";
import {
  attachmentsOf,
  Events,
  makeEvents,
  memoryRevisions,
} from "../../src/contract/hub.js";
import { makeLogStore, memoryStorage } from "../../src/contract/log.js";
import type { LogStorage, Read } from "../../src/contract/log.js";
import { Posted, settle, texts } from "../support/events.js";

const Built = Event.make("build.finished", {
  description: "A build finished.",
  payload: { n: Schema.Int },
  caller: Action.Anyone,
});

const Pushed = Event.make("build.pushed", {
  description: "A build was pushed.",
  payload: { n: Schema.Int },
  caller: Action.Anyone,
});

const Status = Event.make("build.status", {
  description: "The build's status changed.",
  payload: { state: Schema.String },
  caller: Action.Anyone,
});

const logs = [Built, Pushed] as const;

const bounds = { maxAge: 1000, maxEvents: 4 };

const Key = Schema.UndefinedOr(Schema.Literals(["", "a", "b"]));

const Command = Schema.Union([
  Schema.TaggedStruct("Publish", {
    log: Schema.Literals([0, 1]),
    key: Key,
    eventId: Schema.UndefinedOr(Schema.String),
    timestamp: Schema.UndefinedOr(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4e12 }))
    ),
  }),
  Schema.TaggedStruct("Notify", { key: Key }),
  Schema.TaggedStruct("Revision", { key: Key }),
  Schema.TaggedStruct("Restart", {}),
  Schema.TaggedStruct("Read", {
    log: Schema.Literals([0, 1]),
    from: Schema.Union([
      Schema.Literals(["start", "foreign"]),
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30 })),
    ]),
    limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
  }),
]);

const Step = Schema.Struct({
  after: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 600 })),
  command: Command,
});

const Steps = Schema.Array(Step).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(40)
);

type Emitted = Event.Emitted<Event.Any>;

const afterEpoch = (cursor: string) => cursor.slice(cursor.indexOf(":"));

const projected = (
  read: Read<{ value: Emitted; key: string | undefined } | undefined>
) => ({
  truncated: read.truncated,
  hasMore: read.hasMore,
  from: afterEpoch(read.from),
  cursor: afterEpoch(read.cursor),
  entries: read.entries.map(({ seq, at, cursor, value }) => ({
    seq,
    at,
    cursor: afterEpoch(cursor),
    key: value?.key,
    data: value?.value.data,
    eventId: value?.value.eventId,
    timestamp:
      value?.value.timestamp === undefined
        ? undefined
        : DateTime.toEpochMillis(value.value.timestamp),
  })),
});

const opened = (events: Event.Events["Service"]) =>
  Effect.gen(function* () {
    const attachments = yield* attachmentsOf(events);

    return {
      events,
      logs: [
        yield* attachments.log(Built, bounds, undefined),
        yield* attachments.log(Pushed, bounds, undefined),
      ] as const,
      status: yield* attachments.check(Status),
    };
  });

type Opened = Effect.Success<ReturnType<typeof opened>>;

type Command = typeof Command.Type;

const databaseFile = Effect.map(
  Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), "effect-actions-sql-"))),
    (directory) =>
      Effect.sync(() => {
        rmSync(directory, { recursive: true, force: true });
      })
  ),
  (directory) => path.join(directory, "store.db")
);

const sqliteAt = (filename: string) =>
  Layer.orDie(SqliteClient.layer({ filename }));

const cursorFor = (
  from: "start" | "foreign" | number,
  minted: readonly string[]
): string | null | undefined =>
  Match.value(from).pipe(
    Match.when("start", () => null),
    Match.when("foreign", () => "elsewhere:1"),
    Match.orElse((index) => minted[index % Math.max(minted.length, 1)])
  );

const restartable = (build: Effect.Effect<Opened, never, Scope.Scope>) =>
  Effect.gen(function* () {
    let scope = yield* Scope.make();
    let current = yield* Scope.provide(build, scope);
    let firstEpoch: string | undefined;
    const minted: string[] = [];

    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

    return (command: Command, n: number) =>
      Effect.gen(function* () {
        const { events, logs: attached, status } = current;

        switch (command._tag) {
          case "Publish": {
            yield* events.publish(
              logs[command.log],
              {
                data: { n },
                eventId: command.eventId,
                timestamp:
                  command.timestamp === undefined
                    ? undefined
                    : DateTime.makeUnsafe(command.timestamp),
              },
              { key: command.key }
            );

            return undefined;
          }

          case "Notify": {
            yield* events.notify(Status, { key: command.key });

            return undefined;
          }

          case "Revision": {
            const revision = yield* status.revision(command.key);
            const epoch = revision.slice(0, revision.indexOf(":"));

            firstEpoch ??= epoch;

            return {
              epochKept: epoch === firstEpoch,
              revision: afterEpoch(revision),
            };
          }

          case "Restart": {
            yield* Scope.close(scope, Exit.void);
            scope = yield* Scope.make();
            current = yield* Scope.provide(build, scope);

            return undefined;
          }

          case "Read": {
            const cursor = cursorFor(command.from, minted);

            if (cursor === undefined) {
              return undefined;
            }

            const read = yield* attached[command.log].read(
              cursor,
              command.limit
            );

            minted.push(read.cursor);

            return projected(read);
          }
        }
      });
  });

const memorySystem = () => {
  const storages = new Map<string, LogStorage<Emitted>>();
  const revisions = memoryRevisions();

  return restartable(
    Effect.flatMap(
      makeEvents({
        log: (event) => {
          const kept = storages.get(event.name) ?? memoryStorage();

          storages.set(event.name, kept);

          return kept;
        },
        revisions,
      }),
      opened
    )
  );
};

const sqlSystem = Effect.gen(function* () {
  const client = yield* Layer.build(sqliteAt(":memory:"));

  return yield* restartable(
    Effect.flatMap(
      Layer.build(
        Persisted.layerEvents.pipe(Layer.provide(Layer.succeedContext(client)))
      ),
      (built) => opened(Context.get(built, Events))
    )
  );
});

interface Published {
  readonly seq: number;
  readonly at: number;
  readonly cursor: string;
  readonly key: string | undefined;
  readonly data: { readonly n: number };
  readonly eventId: string | undefined;
  readonly timestamp: number | undefined;
}

type Observation = Effect.Success<
  ReturnType<Effect.Success<ReturnType<typeof memorySystem>>>
>;

const everyStep: readonly Command[] = [
  { _tag: "Read", log: 0, from: "foreign", limit: 5 },
  { _tag: "Read", log: 1, from: "foreign", limit: 5 },
  { _tag: "Revision", key: undefined },
  { _tag: "Revision", key: "a" },
];

describe("Persisted.layerEvents", () => {
  it.effect.prop(
    "answers every read and revision as a memory store kept across the same restarts does, each log holding what was published to it within its bounds",
    { steps: Steps },
    ({ steps }) =>
      Effect.gen(function* () {
        const memory = yield* memorySystem();
        const sql = yield* sqlSystem;
        const published: [Published[], Published[]] = [[], []];
        let now = 0;

        for (const [index, { after, command }] of steps.entries()) {
          yield* TestClock.adjust(after);
          now += after;

          if (command._tag === "Publish") {
            const log = published[command.log];

            log.push({
              seq: log.length + 1,
              at: now,
              cursor: `:${log.length + 1}`,
              key: command.key,
              data: { n: index },
              eventId: command.eventId,
              timestamp: command.timestamp,
            });
          }

          const observations: Observation[] = [];

          for (const each of [command, ...everyStep]) {
            const [expected, observed] = yield* Effect.all([
              memory(each, index),
              sql(each, index),
            ]);

            expect(observed).toStrictEqual(expected);
            observations.push(observed);
          }

          const youngest = now - bounds.maxAge;

          const kept = published.map((log) =>
            log
              .filter(
                (entry) =>
                  entry.seq > log.length - bounds.maxEvents &&
                  entry.at >= youngest
              )
              .slice(0, 5)
          );

          expect(
            observations
              .slice(1, 3)
              .map((read) =>
                read !== undefined && "entries" in read ? read.entries : read
              )
          ).toStrictEqual(kept);
        }
      }),
    { arbitrary: { runs: 500 } }
  );
});

describe("Persisted.layerEvents on a database file", () => {
  const logged = Event.implement(Posted, { log: {} });

  it.effect(
    "resumes a watch from a cursor after a restart on the same file, receiving every occurrence past it",
    () =>
      Effect.gen(function* () {
        const onFile = Persisted.layerEvents.pipe(
          Layer.provide(sqliteAt(yield* databaseFile))
        );

        const cursor = yield* Effect.gen(function* () {
          const events = yield* Event.Events;
          const client = yield* Action.client(logged);

          const watching = yield* client
            .watch(Posted, {})
            .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

          yield* settle;

          for (const [id, text] of [
            ["m1", "one"],
            ["m2", "two"],
            ["m3", "three"],
          ] as const) {
            yield* events.publish(Posted, {
              data: { id, channel: "general", text },
            });
          }

          const [one] = yield* Fiber.join(watching);

          if (one?._tag !== "Occurrence" || one.cursor === null) {
            throw new Error("Expected an occurrence with a cursor");
          }

          return one.cursor;
        }).pipe(Effect.scoped, Effect.provide(onFile));

        const resumed = yield* Effect.gen(function* () {
          const client = yield* Action.client(logged);

          return yield* client
            .watch(Posted, {}, { cursor })
            .pipe(Stream.take(2), Stream.runCollect);
        }).pipe(Effect.scoped, Effect.provide(onFile));

        expect(texts(resumed)).toStrictEqual(["two", "three"]);
      })
  );

  it.effect(
    "materializes every source kind for a reader of the database alone: a log's entries, and a revision for each check and current source notified",
    () =>
      Effect.gen(function* () {
        const sources = Event.implement([Built, Pushed, Status], {
          "build.finished": { log: {} },
          "build.pushed": {
            check: () => Effect.succeed({ events: [], cursor: "0" }),
          },
          "build.status": { current: () => Effect.succeed({ state: "green" }) },
        });

        const filename = yield* databaseFile;

        yield* Effect.gen(function* () {
          const events = yield* Event.Events;

          yield* Action.client(sources);
          yield* events.publish(Built, { data: { n: 1 } }, { key: "main" });
          yield* events.notify(Pushed);
          yield* events.notify(Status, { key: "main" });
          yield* events.notify(Status, { key: "main" });
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Persisted.layerEvents.pipe(Layer.provide(sqliteAt(filename)))
          )
        );

        const reader = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          return yield* Effect.all([
            sql`SELECT event, seq, key, value FROM effect_actions_event_log`,
            sql`SELECT name, count FROM effect_actions_event_revision WHERE name IN ('build.pushed', 'build.status') ORDER BY name`,
          ]);
        }).pipe(Effect.provide(sqliteAt(filename)), Effect.orDie);

        expect(
          reader.map((rows) => rows.map((row) => ({ ...row })))
        ).toStrictEqual([
          [
            {
              event: "build.finished",
              seq: 1,
              key: "main",
              value: '{"data":{"n":1}}',
            },
          ],
          [
            { name: "build.pushed", count: 1 },
            { name: "build.status", count: 2 },
          ],
        ]);
      })
  );
});

const atMostHundredParameters: Statement.Transformer = (statement) => {
  const [, parameters] = statement.compile();

  return parameters.length > 100
    ? Effect.die(new Error(`A statement bound ${parameters.length} parameters`))
    : Effect.succeed(statement);
};

describe("the SQL log storage", () => {
  it.effect(
    "binds at most 100 parameters to a statement, Durable Object SQLite's limit, writing, listing and deleting hundreds of entries",
    () =>
      Effect.gen(function* () {
        const sql = (yield* SqlClient.SqlClient).withoutTransforms();

        yield* Layer.build(
          Persisted.layerEvents.pipe(
            Layer.provide(Layer.succeed(SqlClient.SqlClient, sql))
          )
        );

        const storage = sqlStorage(
          sql,
          "build.finished",
          Schema.fromJsonString(Schema.Int)
        );

        const log = makeLogStore(storage, { maxEvents: 1000 });

        for (let n = 1; n <= 250; n += 1) {
          yield* log.append({ value: n, key: undefined });
        }

        yield* storage.delete(Array.from({ length: 200 }, (_, at) => at + 1));

        const [listed, counted] = yield* Effect.all([
          storage.list(0, 300),
          Effect.orDie(
            sql`SELECT count(*) AS count FROM effect_actions_event_log`
          ),
        ]);

        expect([
          listed.map(([seq]) => seq),
          counted[0]?.["count"],
        ]).toStrictEqual([Array.from({ length: 50 }, (_, at) => at + 201), 50]);
      }).pipe(
        Effect.provide(sqliteAt(":memory:")),
        Effect.provideService(
          Statement.CurrentTransformer,
          atMostHundredParameters
        )
      )
  );
});

const Post = Action.make("post", {
  description: "Post a message, once for each request.",
  input: { text: Schema.String, request: Schema.String },
  success: { id: Schema.Int },
  readOnly: false,
  caller: Action.Anyone,
  idempotencyKey: "request",
});

describe("Persisted.layerIdempotency", () => {
  it.effect(
    "answers a repeat after a restart on the same database as the first call was, and runs it again once 24 hours have passed",
    () =>
      Effect.gen(function* () {
        let posted = 0;

        const posting = Action.implement(Post, () =>
          Effect.sync(() => {
            posted += 1;

            return { id: posted };
          })
        );

        const onFile = Layer.provideMerge(
          Persisted.layerIdempotency,
          Layer.provideMerge(
            KeyValueStore.layerSql(),
            sqliteAt(yield* databaseFile)
          )
        );

        const post = (request: string) =>
          Effect.gen(function* () {
            const client = yield* Action.client(posting);

            return yield* client.post({ text: "hi", request });
          }).pipe(Effect.scoped, Effect.provide(onFile));

        const first = yield* post("r1");

        yield* post("r2");

        const repeated = yield* post("r1");

        yield* TestClock.adjust("24 hours");

        const expired = yield* post("r1");

        const kept = yield* Effect.orDie(
          Effect.flatMap(KeyValueStore.KeyValueStore, (store) => store.keys)
        ).pipe(Effect.provide(onFile));

        expect([first, repeated, expired, posted, kept.length]).toStrictEqual([
          { id: 1 },
          { id: 1 },
          { id: 3 },
          3,
          1,
        ]);
      })
  );
});
