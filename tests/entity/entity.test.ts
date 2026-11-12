import { describe, expect, it } from "@effect/vitest";
import { Arbitrary, Cause, Effect, Exit, Layer, Schema, Stream } from "effect";
import {
  Entity,
  MessageStorage,
  ShardingConfig,
  TestRunner,
} from "effect/cluster";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";

import * as Action from "../../src/contract/Action.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionEntity from "../../src/entity/ActionEntity.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import { DeclaredFailure } from "../../src/rpc/erased.js";
import * as Testing from "../../src/testing/Testing.js";
import {
  makeRooms,
  Payload,
  Posted,
  Room,
  RoomClosed,
  RoomRpc,
  signIn,
} from "../support/rooms.js";

type Rooms = ReturnType<typeof makeRooms>;

const signedInAs = (token: string) =>
  RpcClient.withHeaders({ authorization: `Bearer ${token}` });

const onTestRunner = (rooms: Rooms) =>
  ActionEntity.layer(Room, rooms.implementations).pipe(
    Layer.provideMerge(TestRunner.layer),
    Layer.provide([signIn, Event.layerMemory])
  );

const roomClient = ActionEntity.client(Room);

const overRpc = (rooms: Rooms) =>
  RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(
      Testing.layer(
        ActionRpc.layer(RoomRpc, rooms.echoing).pipe(
          Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
          Layer.provide(RpcSerialization.layerNdjson)
        )
      )
    )
  );

const jsonTextOf = Schema.encodeSync(
  Schema.fromJsonString(Schema.toCodecJson(Payload))
);

const Page = Schema.Struct({
  events: Schema.Array(
    Schema.Struct({ data: Schema.Struct({ text: Schema.String }) })
  ),
  cursor: Schema.NullOr(Schema.String),
  truncated: Schema.Boolean,
  hasMore: Schema.Boolean,
  nextPollMs: Schema.Finite,
});

const pageOf = Schema.decodeUnknownEffect(Page);

const poll = (entityId: string, cursor: string | null, maxEvents?: number) =>
  Effect.gen(function* () {
    const rpcs = yield* Room.client;
    const sent = rpcs(entityId)["room.posted"];

    if (sent === undefined) {
      return yield* Effect.die(new Error("no poll rpc"));
    }

    const answer = sent({
      input: { room: entityId },
      cursor,
      ...(maxEvents === undefined ? {} : { maxEvents }),
    });

    if (!Effect.isEffect(answer)) {
      return yield* Effect.die(new Error("a streamed poll"));
    }

    const { events, ...page } = yield* pageOf(yield* answer);

    return { ...page, texts: events.map(({ data }) => data.text) };
  });

const otherThanLobby = Arbitrary.schema(Schema.String).pipe(
  Arbitrary.filter((named) => named !== "lobby")
);

describe("ActionEntity on Entity.makeTestClient", () => {
  it.effect(
    "answers an action, refuses an input naming another entity with Forbidden, and one that does not decode with InvalidInput",
    () => {
      const rooms = makeRooms();

      return Effect.gen(function* () {
        const clientFor = yield* Entity.makeTestClient(
          Room,
          ActionEntity.layer(Room, rooms.implementations)
        );

        const { read } = yield* clientFor("lobby");

        if (read === undefined) {
          return yield* Effect.die(new Error("no read rpc"));
        }

        const answered = read({ room: "lobby" });
        const refusedCall = read({ room: "kitchen" });
        const invalidCall = read({ room: 5 });

        if (
          !Effect.isEffect(answered) ||
          !Effect.isEffect(refusedCall) ||
          !Effect.isEffect(invalidCall)
        ) {
          return yield* Effect.die(new Error("a streamed read"));
        }

        const answer = yield* answered;
        const refused = yield* Effect.flip(refusedCall);
        const invalid = yield* Effect.flip(invalidCall);

        expect(answer).toStrictEqual({ entity: "lobby", texts: [] });
        expect(refused).toBeInstanceOf(DeclaredFailure);
        expect(refused).toMatchObject({ json: { _tag: "Forbidden" } });
        expect(invalid).toMatchObject({ json: { _tag: "InvalidInput" } });
        expect(rooms.ran.read).toBe(1);
      }).pipe(
        Effect.scoped,
        Effect.provide([ShardingConfig.layer(), signIn, Event.layerMemory])
      );
    }
  );
});

const Probe = Action.make("probe", {
  description: "Answer the entity it reached.",
  input: {},
  success: Schema.String,
  readOnly: true,
  caller: Action.Anyone,
});

describe("ActionEntity's streaming action on Entity.makeTestClient", () => {
  it.effect(
    "streams each progress as a Progress before the answer as its Final",
    () => {
      const rooms = makeRooms();

      return Effect.gen(function* () {
        const clientFor = yield* Entity.makeTestClient(
          Room,
          ActionEntity.layer(Room, rooms.implementations)
        );

        const { tally } = yield* clientFor("lobby");

        if (tally === undefined) {
          return yield* Effect.die(new Error("no tally rpc"));
        }

        const sent = tally({ room: "lobby", upTo: 2 });

        if (Effect.isEffect(sent)) {
          return yield* Effect.die(new Error("a unary tally"));
        }

        expect(yield* Stream.runCollect(sent)).toStrictEqual([
          { _tag: "Progress", value: { at: 1 } },
          { _tag: "Progress", value: { at: 2 } },
          { _tag: "Final", value: { counted: 2 } },
        ]);
      }).pipe(
        Effect.scoped,
        Effect.provide([ShardingConfig.layer(), signIn, Event.layerMemory])
      );
    }
  );
});

const Count = Action.make("count", {
  description: "Answer how many builds its implementation ran.",
  input: { room: Schema.String },
  success: Schema.Int,
  readOnly: true,
  caller: Action.Anyone,
});

const Counter = ActionEntity.make("Counter", ActionRpc.make([Count]), {
  key: { count: ({ room }) => room },
});

const Lines = Action.make("lines", {
  description: "Stream a room's numbered lines.",
  input: { room: Schema.String, upTo: Schema.Int },
  success: Action.Stream({ n: Schema.Int }),
  readOnly: true,
  caller: Action.Anyone,
});

const Liner = ActionEntity.make("Liner", ActionRpc.make([Lines]), {
  key: { lines: ({ room }) => room },
});

describe("ActionEntity's stream answer", () => {
  it.live(
    "streams each element of an Action.Stream answer through the typed client, and refuses another entity's key with Forbidden",
    () => {
      let ran = 0;

      const lining = Action.implement(Lines, ({ upTo }) =>
        Stream.fromEffect(Effect.sync(() => (ran += 1))).pipe(
          Stream.flatMap(() =>
            Stream.range(1, upTo).pipe(Stream.map((n) => ({ n })))
          )
        )
      );

      return Effect.gen(function* () {
        const lobby = (yield* ActionEntity.client(Liner))("lobby");

        const elements = yield* Stream.runCollect(
          lobby.lines({ room: "lobby", upTo: 3 })
        );

        const refused = yield* Effect.flip(
          Stream.runCollect(lobby.lines({ room: "kitchen", upTo: 3 }))
        );

        expect(elements).toStrictEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
        expect(refused).toBeInstanceOf(Action.Forbidden);
        expect(ran).toBe(1);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ActionEntity.layer(Liner, lining).pipe(
            Layer.provideMerge(TestRunner.layer)
          )
        )
      );
    }
  );
});

describe("ActionEntity under Action.layer", () => {
  it.live(
    "builds each entity id's implementations itself, sharing no build with Action.layer above it",
    () => {
      let builds = 0;

      const counting = Action.implement(
        Count,
        Effect.sync(() => {
          builds += 1;

          return () => Effect.succeed(builds);
        })
      );

      return Effect.gen(function* () {
        const clientOf = yield* ActionEntity.client(Counter);
        const before = builds;

        yield* clientOf("a").count({ room: "a" });
        yield* clientOf("b").count({ room: "b" });
        yield* clientOf("a").count({ room: "a" });

        expect(before).toBe(1);
        expect(builds).toBe(3);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ActionEntity.layer(Counter, counting).pipe(
            Layer.provideMerge(TestRunner.layer),
            Layer.provideMerge(Action.layer(counting))
          )
        )
      );
    }
  );
});

interface Owner {
  id: string | undefined;
}

describe("ActionEntity's key", () => {
  it.effect(
    "refuses with Forbidden a key that answers no string, its handler never running",
    () => {
      let ran = 0;
      const owner = { id: "lobby" };
      const unset: Owner = owner;

      const Prober = ActionEntity.make("Prober", ActionRpc.make([Probe]), {
        key: { probe: () => owner.id },
      });

      const probing = Action.implement(Probe, () =>
        Effect.sync(() => {
          ran += 1;

          return "reached";
        })
      );

      return Effect.gen(function* () {
        const clientFor = yield* Entity.makeTestClient(
          Prober,
          ActionEntity.layer(Prober, probing)
        );

        const { probe } = yield* clientFor("lobby");

        if (probe === undefined) {
          return yield* Effect.die(new Error("no probe rpc"));
        }

        const keyed = probe({});

        if (!Effect.isEffect(keyed)) {
          return yield* Effect.die(new Error("a streamed probe"));
        }

        expect(yield* keyed).toBe("reached");

        unset.id = undefined;

        const refused = yield* Effect.flip(keyed);

        expect(refused).toMatchObject({ json: { _tag: "Forbidden" } });
        expect(ran).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(ShardingConfig.layer()));
    }
  );
});

describe("ActionEntity on a TestRunner", () => {
  it.live.prop(
    "answers any input as ActionRpc.layer answers it, the payload as JSON carries it",
    [Arbitrary.schema(Payload)],
    ([payload]) => {
      const rooms = makeRooms();

      return Effect.gen(function* () {
        const lobby = (yield* roomClient)("lobby");
        const rpc = yield* ActionRpc.client(RoomRpc);

        const input = { room: "lobby", payload };

        const fromEntity = yield* lobby.echo(input);
        const fromRpc = yield* rpc.echo(input);

        expect(jsonTextOf(fromEntity)).toBe(jsonTextOf(fromRpc));
        expect(jsonTextOf(fromEntity)).toBe(jsonTextOf(payload));
      }).pipe(
        Effect.scoped,
        Effect.provide([onTestRunner(rooms), overRpc(rooms)])
      );
    },
    { timeout: 30_000, arbitrary: { runs: 100 } }
  );

  it.live.prop(
    "refuses any key other than the entity's with Forbidden, its handler never running",
    [otherThanLobby],
    ([other]) => {
      const rooms = makeRooms();

      return Effect.gen(function* () {
        const lobby = (yield* roomClient)("lobby");
        const named = { room: other };

        const refusals = [
          yield* Effect.flip(lobby.read(named)),
          yield* Effect.flip(lobby.shut(named)),
          yield* Effect.flip(lobby.boom(named)),
          yield* Effect.flip(
            lobby.echo({
              ...named,
              payload: {
                text: "",
                amount: 0,
                count: 0,
                level: "low",
                tags: [],
              },
            })
          ),
          yield* Effect.flip(
            lobby.post({ ...named, text: "hi" }).pipe(signedInAs("alice"))
          ),
          yield* Effect.flip(lobby.tally({ ...named, upTo: 2 })),
          yield* Effect.flip(
            Stream.runHead(lobby.watch(Posted, named, { mode: "poll" }))
          ),
        ];

        for (const refused of refusals) {
          expect(refused).toBeInstanceOf(Action.Forbidden);
        }

        expect(rooms.ran).toStrictEqual({
          echo: 0,
          post: 0,
          read: 0,
          tally: 0,
          builds: 1,
        });
      }).pipe(Effect.scoped, Effect.provide(onTestRunner(rooms)));
    },
    { timeout: 30_000, arbitrary: { runs: 50 } }
  );

  it.live("authenticates each call from the headers its client sends", () => {
    const rooms = makeRooms();

    return Effect.gen(function* () {
      const lobby = (yield* roomClient)("lobby");
      const post = { room: "lobby", text: "hi" };

      const answered = yield* lobby.post(post).pipe(signedInAs("alice"));
      const anonymous = yield* Effect.flip(lobby.post(post));

      const unknown = yield* Effect.flip(
        lobby.post(post).pipe(signedInAs("mallory"))
      );

      const elsewhere = yield* Effect.flip(
        lobby.post({ room: "kitchen", text: "hi" })
      );

      expect(answered).toStrictEqual({ count: 1, by: "alice" });
      expect(anonymous).toBeInstanceOf(Action.Unauthenticated);
      expect(unknown).toBeInstanceOf(Action.Unauthenticated);
      expect(elsewhere).toBeInstanceOf(Action.Unauthenticated);
      expect(rooms.ran.post).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(onTestRunner(rooms)));
  });

  it.live("fails with a declared error and its fields", () =>
    Effect.gen(function* () {
      const lobby = (yield* roomClient)("lobby");

      const closed = yield* Effect.flip(lobby.shut({ room: "lobby" }));

      expect(closed).toStrictEqual(
        new RoomClosed({ room: "lobby", reason: "shut" })
      );
    }).pipe(Effect.scoped, Effect.provide(onTestRunner(makeRooms())))
  );

  it.live(
    "answers a defect with Internal server error, and its next call on the same handlers",
    () => {
      const rooms = makeRooms();

      return Effect.gen(function* () {
        const lobby = (yield* roomClient)("lobby");

        const died = yield* Effect.exit(lobby.boom({ room: "lobby" }));
        const read = yield* lobby.read({ room: "lobby" });

        expect(Exit.isFailure(died) && Cause.hasDies(died.cause)).toBe(true);
        expect(
          String(Exit.isFailure(died) && Cause.squash(died.cause))
        ).toContain("Internal server error");
        expect(read).toStrictEqual({ entity: "lobby", texts: [] });
        expect(rooms.ran.builds).toBe(1);
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.scoped,
        Effect.provide(onTestRunner(rooms))
      );
    }
  );

  it.live(
    "keeps each entity's state its own, each building its handlers",
    () => {
      const rooms = makeRooms();

      return Effect.gen(function* () {
        const clientOf = yield* roomClient;

        yield* Effect.forEach(
          ["a", "b", "a"],
          (room, at) =>
            clientOf(room)
              .post({ room, text: `${room}${at}` })
              .pipe(signedInAs("alice")),
          { concurrency: "unbounded" }
        );

        const a = yield* clientOf("a").read({ room: "a" });
        const b = yield* clientOf("b").read({ room: "b" });

        expect({ ...a, texts: a.texts.toSorted() }).toStrictEqual({
          entity: "a",
          texts: ["a0", "a2"],
        });
        expect(b).toStrictEqual({ entity: "b", texts: ["b1"] });
        expect(rooms.ran.builds).toBe(2);
      }).pipe(Effect.scoped, Effect.provide(onTestRunner(rooms)));
    }
  );

  it.live(
    "answers an event's poll rpc past a cursor, and a watch follows it",
    () =>
      Effect.gen(function* () {
        const a = (yield* roomClient)("a");

        const start = yield* poll("a", null);

        for (const text of ["one", "two", "three"]) {
          yield* a.post({ room: "a", text }).pipe(signedInAs("alice"));
        }

        const first = yield* poll("a", start.cursor);
        const second = yield* poll("a", first.cursor);

        const watched = yield* a
          .watch(Posted, { room: "a" }, { cursor: start.cursor })
          .pipe(Stream.take(3), Stream.runCollect);

        expect(start.texts).toStrictEqual([]);
        expect(first.texts).toStrictEqual(["one", "two", "three"]);
        expect(second.texts).toStrictEqual([]);
        expect(
          watched.map((received) =>
            received._tag === "Occurrence" ? received.data.text : "gap"
          )
        ).toStrictEqual(["one", "two", "three"]);
      }).pipe(Effect.scoped, Effect.provide(onTestRunner(makeRooms())))
  );

  it.live(
    "hands a streaming action's progress on before its answer, and refuses another entity's key with Forbidden",
    () => {
      const rooms = makeRooms();

      return Effect.gen(function* () {
        const lobby = (yield* roomClient)("lobby");
        const seen: string[] = [];

        const answer = yield* lobby.tally(
          { room: "lobby", upTo: 3 },
          { onProgress: ({ at }) => Effect.sync(() => seen.push(`at ${at}`)) }
        );

        seen.push(`counted ${answer.counted}`);

        const refused = yield* Effect.flip(
          lobby.tally(
            { room: "kitchen", upTo: 3 },
            { onProgress: () => Effect.sync(() => seen.push("refused")) }
          )
        );

        expect(seen).toStrictEqual(["at 1", "at 2", "at 3", "counted 3"]);
        expect(refused).toBeInstanceOf(Action.Forbidden);
        expect(rooms.ran.tally).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(onTestRunner(rooms)));
    }
  );

  it.live(
    "answers a poll page with hasMore past maxEvents, truncated for a cursor its log never minted, and a 5-second nextPollMs",
    () =>
      Effect.gen(function* () {
        const a = (yield* roomClient)("a");

        const start = yield* poll("a", null);

        for (const text of ["one", "two", "three"]) {
          yield* a.post({ room: "a", text }).pipe(signedInAs("alice"));
        }

        const first = yield* poll("a", start.cursor, 2);
        const rest = yield* poll("a", first.cursor, 2);
        const foreign = yield* poll("a", "minted-elsewhere");

        expect(start).toMatchObject({
          texts: [],
          truncated: false,
          hasMore: false,
          nextPollMs: 5000,
        });
        expect(first).toMatchObject({
          texts: ["one", "two"],
          truncated: false,
          hasMore: true,
          nextPollMs: 5000,
        });
        expect(rest).toMatchObject({
          texts: ["three"],
          truncated: false,
          hasMore: false,
        });
        expect(foreign).toMatchObject({ truncated: true, hasMore: false });
        expect(foreign.cursor).toBe(rest.cursor);
      }).pipe(Effect.scoped, Effect.provide(onTestRunner(makeRooms())))
  );

  it.live(
    "refuses to watch an event as a stream, since an entity serves polls",
    () =>
      Effect.gen(function* () {
        const a = (yield* roomClient)("a");

        const refused = yield* Effect.flip(
          Stream.runHead(a.watch(Posted, { room: "a" }, { mode: "stream" }))
        );

        expect(refused).toBeInstanceOf(Event.SubscriptionError);
        expect(
          refused instanceof Event.SubscriptionError && refused.reason._tag
        ).toBe("Unsupported");
      }).pipe(Effect.scoped, Effect.provide(onTestRunner(makeRooms())))
  );

  it.live("stores no message of its calls", () =>
    Effect.gen(function* () {
      const lobby = (yield* roomClient)("lobby");

      for (let at = 0; at < 10; at += 1) {
        yield* lobby
          .post({ room: "lobby", text: `${at}` })
          .pipe(signedInAs("alice"));
      }

      const driver = yield* MessageStorage.MemoryDriver;

      expect(driver.journal).toStrictEqual([]);
      expect(driver.requests.size).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(onTestRunner(makeRooms())))
  );
});
