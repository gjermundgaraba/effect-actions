import { describe, expect, it } from "@effect/vitest";
import {
  Arbitrary,
  Cause,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Predicate,
  Schema,
  Stream,
} from "effect";
import { ClusterError, Entity, Sharding, TestRunner } from "effect/cluster";
import { HttpClient, HttpClientRequest, HttpServerRequest } from "effect/http";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";

import * as Action from "../../src/contract/Action.js";
import * as Event from "../../src/contract/Event.js";
import * as ActionEntity from "../../src/entity/ActionEntity.js";
import * as ActionHttp from "../../src/http/ActionHttp.js";
import * as ActionMcp from "../../src/mcp/ActionMcp.js";
import * as ActionRpc from "../../src/rpc/ActionRpc.js";
import * as Testing from "../../src/testing/Testing.js";
import { authenticate } from "../support/app/authentication.js";
import {
  actors,
  authorize,
  CurrentActor,
} from "../support/app/authorization.js";
import { Login } from "../support/app/binding.js";
import {
  Boom,
  Echo,
  makeRooms,
  Post,
  Posted,
  Read,
  Room,
  RoomClosed,
  Shut,
  signIn,
  Tally,
} from "../support/rooms.js";
import { unaryOf } from "../support/rpc.js";
import { call } from "../support/sse.js";

type Rooms = ReturnType<typeof makeRooms>;

const RoomHttp = ActionHttp.make(
  [Echo, Post, Read, Shut, Boom, Tally, Posted],
  {
    authentication: Login,
  }
);

const reached = ActionEntity.reaching(Room);

const entities = (rooms: Rooms) =>
  ActionEntity.layer(Room, rooms.implementations).pipe(
    Layer.provideMerge(TestRunner.layer),
    Layer.provide([signIn, Event.layerMemory])
  );

const edge = (rooms: Rooms) =>
  Testing.layer(
    Layer.mergeAll(
      ActionHttp.layer(RoomHttp, reached),
      ActionMcp.layerHttp(reached, {
        name: "worker",
        version: "0.0.0",
        authentication: Login,
        requestScoped: true,
      })
    ).pipe(Layer.provide(authenticate))
  ).pipe(Layer.provideMerge(entities(rooms)));

const bearer = (token: string) =>
  HttpClient.mapRequest(HttpClientRequest.bearerToken(token));

const signedIn = ActionHttp.client(RoomHttp, {
  transformClient: bearer("alice"),
});

const startOf = (room: string) =>
  Effect.gen(function* () {
    const raw = yield* Room.client;

    const answer = unaryOf(
      raw(room)["room.posted/poll"]?.({ input: { room }, cursor: null }),
      "room.posted/poll"
    );

    const { cursor } = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ cursor: Schema.String })
    )(yield* answer);

    return cursor;
  });

const textsOf = (received: ReadonlyArray<Event.Received<typeof Posted>>) =>
  received.map((item) => (item._tag === "Occurrence" ? item.data.text : "gap"));

describe("ActionEntity.reaching on a TestRunner", () => {
  it.live.prop(
    "reaches, for any input, the entity its key names, answering what that entity answers",
    [Arbitrary.schema(Schema.String), Arbitrary.schema(Schema.String)],
    ([room, text]) => {
      const rooms = makeRooms();

      return Effect.gen(function* () {
        const http = yield* signedIn;
        const direct = yield* ActionEntity.client(Room);

        const posted = yield* http.post({ room, text });
        const fromEdge = yield* http.read({ room });
        const fromEntity = yield* direct.read({ room });

        expect(posted).toStrictEqual({ count: 1, by: "alice" });
        expect(fromEdge).toStrictEqual({ entity: room, texts: [text] });
        expect(fromEntity).toStrictEqual(fromEdge);
        expect(rooms.ran.builds).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(edge(rooms)));
    },
    { timeout: 60_000, arbitrary: { runs: 50 } }
  );

  it.live(
    "refuses at the edge, reaching no entity, a protected call without credentials and an input whose key does not decode",
    () => {
      const rooms = makeRooms();

      return Effect.gen(function* () {
        const http = yield* ActionHttp.client(RoomHttp);

        const refused = yield* Effect.flip(
          http.post({ room: "a", text: "hi" })
        );

        const invalid = yield* HttpClient.execute(
          HttpClientRequest.post("/api/read").pipe(
            HttpClientRequest.bodyJsonUnsafe({ room: 5 })
          )
        );

        expect(refused).toBeInstanceOf(Action.Unauthenticated);
        expect(invalid.status).toBe(400);
        expect(yield* invalid.json).toMatchObject({ _tag: "InvalidInput" });
        expect(rooms.ran).toMatchObject({ post: 0, read: 0, builds: 0 });
      }).pipe(Effect.scoped, Effect.provide(edge(rooms)));
    }
  );

  it.live(
    "passes a declared error and a streaming action's progress back through two hops",
    () =>
      Effect.gen(function* () {
        const http = yield* signedIn;
        const seen: number[] = [];

        const closed = yield* Effect.flip(http.shut({ room: "a" }));

        const tallied = yield* http.tally(
          { room: "a", upTo: 3 },
          { onProgress: ({ at }) => Effect.sync(() => seen.push(at)) }
        );

        expect(closed).toStrictEqual(
          new RoomClosed({ room: "a", reason: "shut" })
        );
        expect(tallied).toStrictEqual({ counted: 3 });
        expect(seen).toStrictEqual([1, 2, 3]);
      }).pipe(Effect.scoped, Effect.provide(edge(makeRooms())))
  );

  it.live(
    "follows a room's event through its poll rpc over an HTTP stream, an HTTP poll and MCP's events/poll",
    () =>
      Effect.gen(function* () {
        const http = yield* signedIn;

        const mcp = yield* ActionMcp.client([Read, Posted], {
          transformClient: bearer("alice"),
        });

        const fromA = yield* startOf("a");
        const fromB = yield* startOf("b");

        yield* http.post({ room: "a", text: "one" });
        yield* http.post({ room: "b", text: "elsewhere" });
        yield* http.post({ room: "a", text: "two" });

        const streamed = yield* http
          .watch(Posted, { room: "a" }, { cursor: fromA })
          .pipe(Stream.take(2), Stream.runCollect);

        const polled = yield* http
          .watch(Posted, { room: "a" }, { cursor: fromA, mode: "poll" })
          .pipe(Stream.take(2), Stream.runCollect);

        const viaMcp = yield* mcp
          .watch(Posted, { room: "a" }, { cursor: fromA, mode: "poll" })
          .pipe(Stream.take(2), Stream.runCollect);

        const other = yield* mcp
          .watch(Posted, { room: "b" }, { cursor: fromB, mode: "poll" })
          .pipe(Stream.take(1), Stream.runCollect);

        expect(textsOf(streamed)).toStrictEqual(["one", "two"]);
        expect(textsOf(polled)).toStrictEqual(["one", "two"]);
        expect(textsOf(viaMcp)).toStrictEqual(["one", "two"]);
        expect(textsOf(other)).toStrictEqual(["elsewhere"]);
        expect(yield* mcp.read({ room: "b" })).toStrictEqual({
          entity: "b",
          texts: ["elsewhere"],
        });
      }).pipe(Effect.scoped, Effect.provide(edge(makeRooms())))
  );
});

const Whoami = Action.make("whoami", {
  description: "Answer the authorization header the entity received.",
  input: { room: Schema.String },
  success: Schema.String,
  progress: { step: Schema.Int },
  readOnly: true,
  caller: CurrentActor,
});

const Seen = Event.make("seen", {
  description: "The authorization header the entity received.",
  input: { room: Schema.String },
  payload: { by: Schema.String },
  caller: CurrentActor,
});

const SeerRpc = ActionRpc.make([Whoami, Seen], { authentication: Login });

const SeerHttp = ActionHttp.make([Whoami, Seen], { authentication: Login });

const Seer = ActionEntity.make("Seer", SeerRpc, {
  key: ({ room }) => room,
});

const seeing = [
  Action.implement(
    Whoami,
    Effect.map(
      Event.Events,
      (events) =>
        ({ room }, { progress }) =>
          Effect.gen(function* () {
            yield* progress({ step: 1 });

            const request = yield* HttpServerRequest.HttpServerRequest;
            const by = request.headers["authorization"] ?? "none";

            yield* Effect.log("entity", request.headers);

            yield* events.publish(Seen, { data: { by } }, { key: room });

            return by;
          })
    ),
    { authorize }
  ),
  Event.implement(
    Seen,
    { log: {}, key: ({ room }) => room },
    { authorize: Event.allowAll }
  ),
];

const seers = ActionEntity.layer(Seer, seeing).pipe(
  Layer.provideMerge(TestRunner.layer),
  Layer.provide([signIn, Event.layerMemory])
);

const reachedSeer = ActionEntity.reaching(Seer);

const seerEdge = Testing.layer(
  Layer.mergeAll(
    ActionHttp.layer(SeerHttp, reachedSeer),
    ActionMcp.layerHttp(reachedSeer, {
      name: "worker",
      version: "0.0.0",
      authentication: Login,
      requestScoped: true,
    }),
    ActionRpc.layer(SeerRpc, reachedSeer).pipe(
      Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
      Layer.provide(RpcSerialization.layerNdjson)
    )
  ).pipe(Layer.provide(authenticate))
).pipe(Layer.provideMerge(seers));

const overRpc = RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provideMerge(seerEdge)
);

const asAlice = RpcClient.withHeaders({ authorization: "Bearer alice" });

const seenFrom = (room: string) =>
  Effect.gen(function* () {
    const raw = yield* Seer.client;

    const answer = unaryOf(
      raw(room)["seen/poll"]?.({ input: { room }, cursor: null }),
      "seen/poll"
    );

    const { cursor } = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ cursor: Schema.String })
    )(yield* asAlice(answer));

    return cursor;
  });

const byOf = (received: ReadonlyArray<Event.Received<typeof Seen>>) =>
  received.map((item) => (item._tag === "Occurrence" ? item.data.by : "gap"));

const outcome = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.match(effect, {
    onFailure: (error) =>
      Predicate.isTagged(error, "Unauthenticated")
        ? "Unauthenticated"
        : "failed",
    onSuccess: (value) => value,
  });

const watched = <E>(watch: Stream.Stream<Event.Received<typeof Seen>, E>) =>
  outcome(
    watch.pipe(
      Stream.take(2),
      Stream.runCollect,
      Effect.map(byOf),
      Effect.timeout("10 seconds")
    )
  );

describe("ActionEntity.reaching's protected calls and watches", () => {
  it.live(
    "reach the entity with the caller's credential through an HTTP, an MCP and an RPC edge",
    () =>
      Effect.gen(function* () {
        const http = yield* ActionHttp.client(SeerHttp, {
          transformClient: bearer("alice"),
        });

        const mcp = yield* ActionMcp.client([Whoami, Seen], {
          transformClient: bearer("alice"),
        });

        const rpc = yield* ActionRpc.client(SeerRpc);
        const from = yield* seenFrom("a");

        const direct = yield* ActionEntity.client(Seer);

        for (let at = 0; at < 2; at += 1) {
          yield* asAlice(direct.whoami({ room: "a" }));
        }

        const seen = [
          yield* outcome(http.whoami({ room: "a" })),
          yield* outcome(mcp.whoami({ room: "a" })),
          yield* outcome(asAlice(rpc.whoami({ room: "a" }))),
          yield* watched(http.watch(Seen, { room: "a" }, { cursor: from })),
          yield* watched(
            http.watch(Seen, { room: "a" }, { cursor: from, mode: "poll" })
          ),
          yield* watched(
            mcp.watch(Seen, { room: "a" }, { cursor: from, mode: "poll" })
          ),
          yield* asAlice(
            watched(rpc.watch(Seen, { room: "a" }, { cursor: from }))
          ),
        ];

        const twice = ["Bearer alice", "Bearer alice"];

        expect(seen).toStrictEqual([
          "Bearer alice",
          "Bearer alice",
          "Bearer alice",
          twice,
          twice,
          twice,
          twice,
        ]);
      }).pipe(Effect.scoped, Effect.provide(overRpc))
  );
});

const Hooked = Event.make("hooked", {
  description: "Nothing, behind a subscription hook.",
  input: { room: Schema.String },
  payload: { by: Schema.String },
  caller: CurrentActor,
});

const Hooks = ActionEntity.make(
  "Hooks",
  ActionRpc.make([Hooked], { authentication: Login }),
  { key: ({ room }) => room }
);

describe("ActionEntity.reaching's polls", () => {
  it.live(
    "set a protected event's subscription hook up in the entity for each principal polling over HTTP, as that caller",
    () =>
      Effect.gen(function* () {
        const held: string[] = [];

        const hooked = Event.implement(
          Hooked,
          {
            check: () => Effect.succeed({ cursor: "0", events: [] }),
            subscription: () =>
              Effect.flatMap(CurrentActor, (actor) =>
                Effect.sync(() => held.push(actor.id))
              ),
          },
          { authorize: Event.allowAll }
        );

        const hooks = ActionEntity.layer(Hooks, hooked).pipe(
          Layer.provideMerge(TestRunner.layer),
          Layer.provide([signIn, Event.layerMemory])
        );

        const statuses = yield* Effect.forEach(
          ["alice", "bob", "alice"],
          (token) =>
            Effect.map(
              call(
                "events/hooked",
                { input: { room: "a" }, cursor: null },
                { authorization: `Bearer ${token}` }
              ),
              (response) => response.status
            )
        ).pipe(
          Effect.provide(
            Testing.layer(
              ActionHttp.layer(
                ActionHttp.make([Hooked], { authentication: Login }),
                ActionEntity.reaching(Hooks)
              ).pipe(Layer.provide(authenticate))
            ).pipe(Layer.provideMerge(hooks))
          )
        );

        expect(statuses).toStrictEqual([200, 200, 200]);
        expect(held).toStrictEqual(["alice", "bob"]);
      })
  );
});

interface Owner {
  id: string | undefined;
}

describe("ActionEntity.reaching's key", () => {
  it.live(
    "refuses with Forbidden a call and a poll whose input's key answers no string, reaching no entity",
    () => {
      const counted = { builds: 0, ran: 0 };
      const owner = { id: "lobby" };
      const unset: Owner = owner;

      const Probe = Action.make("probe", {
        description: "Answer the entity it reached.",
        input: {},
        success: Schema.String,
        readOnly: true,
        caller: Action.Anyone,
      });

      const Probed = Event.make("probed", {
        description: "The entity was probed.",
        payload: {},
        caller: Action.Anyone,
      });

      const Prober = ActionEntity.make(
        "Prober",
        ActionRpc.make([Probe, Probed]),
        { key: () => owner.id }
      );

      const sourced = Event.implement(Probed, {
        check: () => Effect.succeed({ cursor: "0", events: [] }),
      });

      const probing = Action.implement(
        Probe,
        Effect.map(Entity.CurrentAddress, ({ entityId }) => {
          counted.builds += 1;

          return () =>
            Effect.sync(() => {
              counted.ran += 1;

              return entityId;
            });
        })
      );

      return Effect.gen(function* () {
        const client = yield* Action.client(ActionEntity.reaching(Prober));

        const answered = yield* client.probe();

        unset.id = undefined;

        const refused = yield* Effect.flip(client.probe());

        const unpolled = yield* Effect.flip(
          Stream.runDrain(client.watch(Probed, {}, { mode: "poll" }))
        );

        expect(answered).toBe("lobby");
        expect(refused).toBeInstanceOf(Action.Forbidden);
        expect(unpolled).toBeInstanceOf(Action.Forbidden);
        expect(counted).toStrictEqual({ builds: 1, ran: 1 });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ActionEntity.layer(Prober, [probing, sourced]).pipe(
            Layer.provideMerge(TestRunner.layer),
            Layer.provide(Event.layerMemory)
          )
        )
      );
    }
  );
});

const Lines = Action.make("lines", {
  description: "Stream numbered lines from the room's entity.",
  input: { room: Schema.String, upTo: Schema.Int },
  success: Action.Stream({ n: Schema.Int, entity: Schema.String }),
  readOnly: true,
  caller: Action.Anyone,
});

const Liner = ActionEntity.make("Liner", ActionRpc.make([Lines]), {
  key: ({ room }) => room,
});

describe("ActionEntity.reaching's stream answer", () => {
  it.live(
    "streams each element of an Action.Stream answer from the entity its key names, through HTTP and in process",
    () => {
      const lining = Action.implement(
        Lines,
        Effect.map(
          Entity.CurrentAddress,
          ({ entityId }) =>
            ({ upTo }) =>
              Stream.range(1, upTo).pipe(
                Stream.map((n) => ({ n, entity: entityId }))
              )
        )
      );

      const reachedLiner = ActionEntity.reaching(Liner);
      const LinerHttp = ActionHttp.make([Lines]);

      return Effect.gen(function* () {
        const http = yield* ActionHttp.client(LinerHttp);
        const inProcess = yield* Action.client(reachedLiner);

        const overHttp = yield* Stream.runCollect(
          http.lines({ room: "lobby", upTo: 3 })
        );

        const direct = yield* Stream.runCollect(
          inProcess.lines({ room: "kitchen", upTo: 2 })
        );

        expect(overHttp).toStrictEqual([
          { n: 1, entity: "lobby" },
          { n: 2, entity: "lobby" },
          { n: 3, entity: "lobby" },
        ]);
        expect(direct).toStrictEqual([
          { n: 1, entity: "kitchen" },
          { n: 2, entity: "kitchen" },
        ]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Testing.layer(ActionHttp.layer(LinerHttp, reachedLiner)).pipe(
            Layer.provideMerge(
              ActionEntity.layer(Liner, lining).pipe(
                Layer.provideMerge(TestRunner.layer)
              )
            )
          )
        )
      );
    }
  );
});

describe("ActionEntity.reaching's headers", () => {
  it.live(
    "sends the caller's authorization exactly, while the entity's logs and the caller's, during and after the call, redact it",
    () => {
      const logged: string[] = [];

      const request = HttpServerRequest.fromWeb(
        new Request("http://localhost/whoami", {
          headers: { authorization: "Bearer alice" },
        })
      );

      const logHeaders = Effect.log(request.headers);

      return Effect.gen(function* () {
        const client = yield* Action.client(ActionEntity.reaching(Seer));

        const seen = yield* client.whoami(
          { room: "a" },
          { onProgress: () => logHeaders }
        );

        yield* logHeaders;

        expect(seen).toBe("Bearer alice");
        expect(
          logged.filter((line) => line.startsWith('["entity"'))
        ).toHaveLength(1);
        expect(logged).toHaveLength(3);

        for (const line of logged) {
          expect(line).toContain('"authorization":"<redacted>"');
          expect(line).not.toContain("Bearer alice");
        }
      }).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        Effect.provideService(CurrentActor, actors.alice),
        Effect.provide(
          Logger.layer([
            Logger.make(({ message }) => {
              logged.push(JSON.stringify(message));
            }),
          ])
        ),
        Effect.scoped,
        Effect.provide(seers)
      );
    }
  );
});

const unreachable = Layer.effect(
  Sharding.Sharding,
  Effect.map(Sharding.Sharding, (sharding) =>
    Sharding.Sharding.of({
      ...sharding,
      makeClient: (entity) =>
        Effect.map(
          sharding.makeClient(entity),
          (clientFor) => (entityId: string) =>
            new Proxy(clientFor(entityId), {
              get: () => () =>
                Effect.fail(
                  new ClusterError.PersistenceError({
                    cause: new Error("storage down"),
                  })
                ),
            })
        ),
    })
  )
);

describe("ActionEntity.reaching's cluster failures", () => {
  it.live(
    "answers Entity.client's PersistenceError as Action.Unavailable, typed in process and over MCP, and a 503 with Retry-After over HTTP, never a 500",
    () => {
      const rooms = makeRooms();

      return Effect.gen(function* () {
        const inProcess = yield* Action.client(reached);
        const direct = yield* ActionEntity.client(Room);

        const failed = yield* Effect.flip(inProcess.read({ room: "a" }));
        const directly = yield* Effect.flip(direct.read({ room: "a" }));

        const mcp = yield* ActionMcp.client([Read], {
          transformClient: bearer("alice"),
        });

        const overMcp = yield* Effect.flip(mcp.read({ room: "a" }));

        const answered = yield* call(
          "read",
          { room: "a" },
          { "content-type": "application/json" }
        );

        expect(failed).toBeInstanceOf(Action.Unavailable);
        expect(failed.message).toBe(
          "read: the entity Room/a could not be reached (PersistenceError); the call's outcome is unknown, as the entity may still run it"
        );
        expect(answered.status).toBe(503);
        expect(answered.headers["retry-after"]).toBe("1");
        expect(yield* answered.json).toStrictEqual({
          _tag: "Unavailable",
          message: failed.message,
        });
        expect(overMcp).toStrictEqual(failed);
        expect(directly).toStrictEqual(failed);
        expect(rooms.ran.read).toBe(0);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Testing.layer(
            Layer.mergeAll(
              ActionHttp.layer(RoomHttp, reached),
              ActionMcp.layerHttp(reached, {
                name: "worker",
                version: "0.0.0",
                authentication: Login,
                requestScoped: true,
              })
            ).pipe(Layer.provide(authenticate))
          ).pipe(
            Layer.provideMerge(unreachable),
            Layer.provideMerge(entities(rooms))
          )
        )
      );
    }
  );
});

const Nap = Action.make("nap", {
  description: "Sleep for the milliseconds given, then answer the entity.",
  input: { room: Schema.String, ms: Schema.Int },
  success: Schema.String,
  readOnly: true,
  caller: Action.Anyone,
});

const NapRpc = ActionRpc.make([Nap]);

const Napper = ActionEntity.make("Napper", NapRpc, {
  key: ({ room }) => room,
});

const napping = Action.implement(
  Nap,
  Effect.map(
    Entity.CurrentAddress,
    ({ entityId }) =>
      ({ ms }) =>
        Effect.as(Effect.sleep(ms), entityId)
  )
);

const nappers = ActionEntity.layer(Napper, napping).pipe(
  Layer.provideMerge(TestRunner.layer)
);

describe("ActionEntity.reaching's timeout", () => {
  it.live(
    "answers a call past it with Action.Unavailable, in process and as a 503 with Retry-After over HTTP, and one within it as the entity does",
    () => {
      const hurried = ActionEntity.reaching(Napper, { timeout: "200 millis" });
      const NapHttp = ActionHttp.make([Nap]);

      return Effect.gen(function* () {
        const inProcess = yield* Action.client(hurried);

        const direct = yield* ActionEntity.client(Napper, {
          timeout: "200 millis",
        });

        const quick = yield* inProcess.nap({ room: "a", ms: 0 });
        const late = yield* Effect.flip(inProcess.nap({ room: "a", ms: 5000 }));

        const lateDirectly = yield* Effect.flip(
          direct.nap({ room: "c", ms: 5000 })
        );

        const answered = yield* call(
          "nap",
          { room: "b", ms: 5000 },
          { "content-type": "application/json" }
        );

        expect(quick).toBe("a");
        expect(late).toBeInstanceOf(Action.Unavailable);
        expect(late.message).toContain(
          "the entity Napper/a did not answer within"
        );
        expect(late.message).toContain("the call's outcome is unknown");
        expect(lateDirectly).toBeInstanceOf(Action.Unavailable);
        expect(lateDirectly.message).toBe(
          "nap: the entity Napper/c did not answer within 200ms; the call's outcome is unknown, as the entity may still run it"
        );
        expect(answered.status).toBe(503);
        expect(answered.headers["retry-after"]).toBe("1");
        expect(yield* answered.json).toMatchObject({ _tag: "Unavailable" });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Testing.layer(ActionHttp.layer(NapHttp, hurried)).pipe(
            Layer.provideMerge(nappers)
          )
        )
      );
    }
  );

  it.live("keeps a caller's interrupt an interrupt, never an Unavailable", () =>
    Effect.gen(function* () {
      const inProcess = yield* Action.client(ActionEntity.reaching(Napper));

      const running = yield* Effect.forkChild(
        inProcess.nap({ room: "a", ms: 5000 })
      );

      yield* Effect.sleep("100 millis");

      yield* Fiber.interrupt(running);

      const exit = yield* Fiber.await(running);

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(
        true
      );
    }).pipe(Effect.scoped, Effect.provide(nappers))
  );

  it.live(
    "bounds each poll alone, so a watch over HTTP's event stream and one polling in process outlive it, never failing to reconnect",
    () => {
      const hurried = ActionEntity.reaching(Room, { timeout: "200 millis" });
      const warned: unknown[] = [];

      const warnings = Logger.layer([
        Logger.make(({ logLevel, message }) => {
          if (logLevel === "Warn" || logLevel === "Error") {
            warned.push(message);
          }
        }),
      ]);

      return Effect.gen(function* () {
        const http = yield* signedIn;
        const inProcess = yield* Action.client(hurried);
        const from = yield* startOf("a");

        const streamed = yield* Effect.forkChild(
          http
            .watch(Posted, { room: "a" }, { cursor: from })
            .pipe(Stream.take(1), Stream.runCollect)
        );

        const polled = yield* Effect.forkChild(
          inProcess
            .watch(Posted, { room: "a" }, { cursor: from, mode: "poll" })
            .pipe(Stream.take(1), Stream.runCollect)
        );

        yield* Effect.sleep("1 second");

        yield* http.post({ room: "a", text: "late" });

        expect(textsOf(yield* Fiber.join(streamed))).toStrictEqual(["late"]);
        expect(textsOf(yield* Fiber.join(polled))).toStrictEqual(["late"]);
        expect(warned).toStrictEqual([]);
      }).pipe(
        Effect.timeout("20 seconds"),
        Effect.scoped,
        Effect.provide(
          Testing.layer(
            ActionHttp.layer(RoomHttp, hurried).pipe(
              Layer.provide(authenticate)
            )
          ).pipe(
            Layer.provideMerge(entities(makeRooms())),
            Layer.provideMerge(warnings)
          )
        )
      );
    },
    { timeout: 30_000 }
  );
});
