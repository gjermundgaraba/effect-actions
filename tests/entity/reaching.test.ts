import { describe, expect, it } from "@effect/vitest";
import { Arbitrary, Effect, Layer, Logger, Schema, Stream } from "effect";
import { Entity, TestRunner } from "effect/cluster";
import { HttpClient, HttpClientRequest, HttpServerRequest } from "effect/http";

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
    const poll = raw(room)["room.posted"];

    if (poll === undefined) {
      return yield* Effect.die(new Error("no poll rpc"));
    }

    const answer = poll({ input: { room }, cursor: null });

    if (!Effect.isEffect(answer)) {
      return yield* Effect.die(new Error("a streamed poll"));
    }

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
        const direct = (yield* ActionEntity.client(Room))(room);

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
    "refuses a protected call without credentials at the edge, reaching no entity",
    () => {
      const rooms = makeRooms();

      return Effect.gen(function* () {
        const http = yield* ActionHttp.client(RoomHttp);

        const refused = yield* Effect.flip(
          http.post({ room: "a", text: "hi" })
        );

        expect(refused).toBeInstanceOf(Action.Unauthenticated);
        expect(rooms.ran).toMatchObject({ post: 0, builds: 0 });
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

const Seer = ActionEntity.make(
  "Seer",
  ActionRpc.make([Whoami], { authentication: Login }),
  {
    key: { whoami: ({ room }) => room },
  }
);

const seeing = Action.implement(
  Whoami,
  (_, { progress }) =>
    Effect.gen(function* () {
      yield* progress({ step: 1 });

      const request = yield* HttpServerRequest.HttpServerRequest;

      return request.headers["authorization"] ?? "none";
    }),
  { authorize }
);

interface Owner {
  id: string | undefined;
}

describe("ActionEntity.reaching's key", () => {
  it.live(
    "refuses with Forbidden an input whose key answers no string, reaching no entity",
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

      const Prober = ActionEntity.make("Prober", ActionRpc.make([Probe]), {
        key: { probe: () => owner.id },
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

        expect(answered).toBe("lobby");
        expect(refused).toBeInstanceOf(Action.Forbidden);
        expect(counted).toStrictEqual({ builds: 1, ran: 1 });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ActionEntity.layer(Prober, probing).pipe(
            Layer.provideMerge(TestRunner.layer)
          )
        )
      );
    }
  );
});

describe("ActionEntity.reaching's headers", () => {
  it.live(
    "sends the caller's authorization exactly, while the caller's own logs, during and after the call, redact it",
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
        expect(logged).toHaveLength(2);

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
        Effect.provide(
          ActionEntity.layer(Seer, seeing).pipe(
            Layer.provideMerge(TestRunner.layer),
            Layer.provide(signIn)
          )
        )
      );
    }
  );
});
