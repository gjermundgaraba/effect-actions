import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster";
import { describe, expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
  Duration,
  Effect,
  Fiber,
  Layer,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Socket } from "effect/socket";

import { LobbyHttp, RoomHttp } from "../src/Api.js";
import { initialize } from "../src/application.js";
import type { Application } from "../src/application.js";
import {
  followLobby,
  followRoom,
  openRoom,
  overSocket,
} from "../src/browser.js";
import { MessagePosted, PostMessage } from "../src/chat/Chat.js";
import type { DemoRoomName } from "../src/chat/Chat.js";
import { day, Expire, windowOf } from "../src/chat/Tells.js";
import type { Task } from "../src/chat/Tells.js";
import { Lobby, Room } from "../src/entities.js";
import { Login } from "../src/identity/Identity.js";
import { protocolVersion } from "../src/Rpc.js";
import {
  baseUrl,
  deliverNow,
  evict,
  objectOf,
  rowsIn,
  sqlIn,
  worker,
} from "./support.js";

const socketTo = (room: DemoRoomName) =>
  overSocket.pipe(
    Layer.provide(
      Layer.effect(Socket.Socket)(
        Socket.fromWebSocket(
          Effect.acquireRelease(
            Effect.flatMap(
              Effect.promise(
                async () =>
                  await exports.default.fetch(
                    `${baseUrl}/rooms/${room}/rpc?protocol=${protocolVersion}`,
                    { headers: { upgrade: "websocket" } }
                  )
              ),
              ({ status, webSocket }) => {
                if (webSocket === null) {
                  return Effect.die(new Error(`No WebSocket: ${status}`));
                }

                webSocket.accept();

                return Effect.succeed(webSocket);
              }
            ),
            (webSocket) =>
              Effect.sync(() => {
                webSocket.close(1000);
              })
          )
        )
      )
    )
  );

const jsonAs = (token?: string) =>
  ActionHttp.client(RoomHttp, {
    baseUrl,
    ...(token === undefined
      ? {}
      : {
          transformClient: HttpClient.mapRequest(
            HttpClientRequest.bearerToken(token)
          ),
        }),
  });

const agentAs = (token: string) =>
  ActionMcp.client([PostMessage, MessagePosted], {
    url: `${baseUrl}/mcp`,
    authentication: Login,
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.bearerToken(token)
    ),
  });

const eventually = <A, E>(
  check: Effect.Effect<A, E>,
  until: (value: A) => boolean
) =>
  check.pipe(
    Effect.repeat({ until, schedule: Schedule.spaced("50 millis") }),
    Effect.timeout("10 seconds")
  );

const arrivedIn = (received: readonly unknown[]) => (count: number) =>
  eventually(
    Effect.sync(() => received.length),
    (length) => length >= count
  );

const retryOf = (room: DemoRoomName, task: Task, after: number) =>
  eventually(
    rowsIn(
      "Room",
      room,
      `SELECT deliver_at FROM cluster_messages WHERE processed = 0 AND json_extract(envelope, '$.tag') = 'retry' AND json_extract(envelope, '$.payload.task') = '${task}' AND deliver_at > ${after}`
    ),
    (rows) => rows.length > 0
  );

const failing = (type: string, id: string, trigger: string) =>
  Effect.acquireRelease(sqlIn(type, id, trigger), () =>
    sqlIn(type, id, "DROP TRIGGER IF EXISTS planted_failure")
  );

const Tells = Schema.Array(
  Schema.Struct({
    deliver_at: Schema.NullOr(Schema.Int),
    processed: Schema.Int,
    task: Schema.NullOr(Schema.String),
    at: Schema.NullOr(Schema.Int),
    attempt: Schema.NullOr(Schema.Int),
  })
);

const tellsOf = (type: string, id: string, tag: string) =>
  Effect.promise(
    async () =>
      await runInDurableObject(objectOf(type, id), (_, state) =>
        state.storage.sql
          .exec(
            "SELECT deliver_at, processed, json_extract(envelope, '$.payload.task') AS task, json_extract(envelope, '$.payload.at') AS at, json_extract(envelope, '$.payload.attempt') AS attempt FROM cluster_messages WHERE json_extract(envelope, '$.tag') = ?",
            tag
          )
          .toArray()
      )
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Tells)), Effect.orDie);

const inApplication = <A, E>(effect: Effect.Effect<A, E, Application>) =>
  Effect.flatMap(
    Effect.promise(async () => await initialize(env)),
    (context) => Effect.provideContext(effect, context)
  );

const expireNow = (room: DemoRoomName) =>
  inApplication(
    Effect.flatMap(Room.client, (rooms) =>
      rooms(room).expire(new Expire({ at: Date.now() }), { discard: true })
    )
  );

const Versions = Schema.Array(
  Schema.fromJsonString(Schema.Struct({ version: Schema.Int }))
);

const versionIn = (room: DemoRoomName) =>
  rowsIn(
    "Lobby",
    "lobby",
    `SELECT version FROM previews WHERE room = '${room}'`
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Versions)),
    Effect.map((rows) => rows[0]?.version ?? 0),
    Effect.orDie
  );

const generalIn = (
  previews: ReadonlyArray<{ room: string; latestAt: number | null }>
) => previews.find(({ room }) => room === "general")?.latestAt;

const StubCalls = Schema.Struct({
  invokes: Schema.Array(
    Schema.Struct({
      object: Schema.String,
      tag: Schema.String,
      settled: Schema.Boolean,
    })
  ),
  others: Schema.Struct({ hold: Schema.Int, acknowledge: Schema.Int }),
});

const settledStubCalls = Effect.promise(
  async () =>
    await exports.default
      .fetch(`${baseUrl}/stub-calls`)
      .then(async (response) => await response.json())
).pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(StubCalls)),
  Effect.orDie,
  Effect.repeat({
    until: ({ invokes }) => invokes.every(({ settled }) => settled),
    schedule: Schedule.spaced("100 millis"),
  })
);

const Held = Schema.Array(
  Schema.Struct({
    calls: Schema.Array(Schema.Unknown),
    parked: Schema.Array(Schema.Unknown),
  })
);

const parkedIn = (room: DemoRoomName, sockets: number) =>
  Effect.promise(
    async () =>
      await runInDurableObject(objectOf("Room", room), (_, state) =>
        state
          .getWebSockets()
          .map((socket): unknown => socket.deserializeAttachment())
      )
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Held)),
    Effect.orDie,
    Effect.repeat({
      until: (held) =>
        held.length === sockets &&
        held.every(
          ({ calls, parked }) => calls.length === 0 && parked.length === 1
        ),
      schedule: Schedule.spaced("100 millis"),
    }),
    Effect.timeout("20 seconds")
  );

const LastPosted = Schema.Array(Schema.Struct({ at: Schema.Int }));

const lastPostedAt = (room: DemoRoomName) =>
  Effect.promise(
    async () =>
      await runInDurableObject(objectOf("Room", room), (_, state) => {
        try {
          return state.storage.sql
            .exec("SELECT at FROM messages ORDER BY id DESC LIMIT 1")
            .toArray();
        } catch {
          return [];
        }
      })
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(LastPosted)),
    Effect.map((rows) => rows[0]?.at ?? null),
    Effect.orDie
  );

const counted = (
  calls: ReadonlyArray<{ readonly object: string; readonly tag: string }>
) => {
  const counts: Record<string, number> = {};

  for (const { object, tag } of calls) {
    const address = CloudflareCluster.decodeName(object);
    const call = `${address?.type ?? object}/${address?.id ?? ""} ${tag}`;

    counts[call] = (counts[call] ?? 0) + 1;
  }

  return counts;
};

const timed = <A, E>(call: Effect.Effect<A, E>) =>
  Effect.map(Effect.timed(call), ([took, value]) => ({
    took: Duration.toMillis(took),
    value,
  }));

describe("the Worker and its rooms", () => {
  it.effect("reads the messages posted after an id", () =>
    Effect.gen(function* () {
      const reader = yield* openRoom(baseUrl, "general", "ada");
      const json = yield* jsonAs("ada");

      const first = yield* reader.post("Through the page's client.");

      const second = yield* json.postMessage({
        room: "general",
        text: "Through the JSON routes.",
      });

      expect(yield* reader.read(first.id - 1)).toStrictEqual([first, second]);
      expect(yield* reader.read(first.id)).toStrictEqual([second]);
    }).pipe(Effect.provide(worker))
  );

  it.effect(
    "posts a message sent again with its request once, answering the repeat as the first across the room's eviction",
    () =>
      Effect.gen(function* () {
        const json = yield* jsonAs("ada");

        const sent = {
          room: "general",
          text: "Sent twice.",
          request: crypto.randomUUID(),
        } as const;

        const first = yield* json.postMessage(sent);

        yield* evict("Room", "general");

        expect(yield* json.postMessage(sent)).toStrictEqual(first);

        const { messages } = yield* json.readMessages({
          room: "general",
          after: first.id - 1,
        });

        expect(messages).toStrictEqual([first]);
      }).pipe(Effect.provide(worker))
  );

  it.effect(
    "refuses a room DemoRoomName does not list with InvalidInput, before any object holds it",
    () =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(
          async () =>
            await exports.default.fetch(`${baseUrl}/api/postMessage`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: "Bearer ada",
              },
              body: JSON.stringify({ room: "kitchen", text: "Hello?" }),
            })
        );

        const body = yield* Effect.promise(
          async () => await response.json()
        ).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.Struct({ _tag: Schema.String }))
          )
        );

        expect(response.status).toBe(400);
        expect(body._tag).toBe("InvalidInput");
        expect(
          yield* rowsIn(
            "Room",
            "kitchen",
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'"
          )
        ).toStrictEqual([]);
      })
  );

  it.effect("refuses, in a room's entity, a call naming another room", () =>
    Effect.gen(function* () {
      const context = yield* Effect.promise(async () => await initialize(env));

      const clientFor = yield* Effect.provideContext(Room.client, context);

      const { readMessages } = clientFor("design");

      if (readMessages === undefined) {
        return yield* Effect.die(new Error("no readMessages rpc"));
      }

      const call = readMessages(
        { room: "general", after: 0 },
        { headers: { authorization: "Bearer ada" } }
      );

      if (!Effect.isEffect(call)) {
        return yield* Effect.die(new Error("a streamed readMessages"));
      }

      const refused = yield* Effect.flip(call);

      expect(refused).toMatchObject({ json: { _tag: "Forbidden" } });
      expect(String(refused)).toContain("names general");
    })
  );

  it.effect("refuses a member outside the room, and a signed-out caller", () =>
    Effect.gen(function* () {
      const grace = yield* jsonAs("grace");
      const anonymous = yield* jsonAs();

      expect(
        yield* Effect.flip(
          grace.postMessage({ room: "design", text: "Let me in." })
        )
      ).toBeInstanceOf(Action.Forbidden);
      expect(
        yield* Effect.flip(
          anonymous.postMessage({ room: "design", text: "Anonymous." })
        )
      ).toBeInstanceOf(Action.Unauthenticated);
    }).pipe(Effect.provide(worker))
  );

  it.effect("refuses to delete another member's message", () =>
    Effect.gen(function* () {
      const ada = yield* openRoom(baseUrl, "general", "ada");
      const grace = yield* openRoom(baseUrl, "general", "grace");

      const posted = yield* ada.post("Mine.");

      expect(yield* grace.remove(posted.id)).toBe("not-yours");
      expect(yield* grace.read(posted.id - 1)).toStrictEqual([posted]);
    }).pipe(Effect.provide(worker))
  );

  it.live(
    "deletes a member's own message, the room no longer reading it and the lobby showing the message before it",
    () =>
      Effect.gen(function* () {
        const ada = yield* openRoom(baseUrl, "general", "ada");
        const lobby = yield* ActionHttp.client(LobbyHttp, { baseUrl });

        const kept = yield* ada.post("Kept.");

        yield* Effect.sleep("5 millis");

        const deleted = yield* ada.post("Deleted.");

        expect(deleted.at).toBeGreaterThan(kept.at);

        yield* eventually(
          lobby.previews(),
          ({ previews }) => generalIn(previews) === deleted.at
        );

        expect(yield* ada.remove(deleted.id)).toBe("removed");
        expect(yield* ada.read(kept.id - 1)).toStrictEqual([kept]);

        const { previews } = yield* eventually(
          lobby.previews(),
          (answer) => generalIn(answer.previews) === kept.at
        );

        expect(generalIn(previews)).toBe(kept.at);
      }).pipe(Effect.provide(worker)),
    { timeout: 30_000 }
  );

  it.live(
    "follows a room through MessagePosted over its socket, from the last id a page read, across the room's eviction",
    () =>
      Effect.gen(function* () {
        const page = yield* openRoom(baseUrl, "design", "ada");
        const messages = yield* followRoom("design", "ada");

        const before = yield* page.post("Before the page watched.");

        const received: unknown[] = [];

        yield* messages(before.id).pipe(
          Stream.runForEach((item) => Effect.sync(() => received.push(item))),
          Effect.forkScoped
        );

        const first = yield* page.post("While the page watches.");

        yield* arrivedIn(received)(1);

        yield* Effect.promise(async () => {
          await evictDurableObject(objectOf("Room", "design"));
        });

        const second = yield* page.post("After the room's eviction.");

        yield* arrivedIn(received)(2);

        expect(received).toMatchObject([
          { _tag: "Occurrence", data: first },
          { _tag: "Occurrence", data: second },
        ]);
      }).pipe(Effect.scoped, Effect.provide([worker, socketTo("design")])),
    { timeout: 30_000 }
  );

  it.live(
    "follows a room through MessagePosted over one JSON watch held open across the room's eviction",
    () =>
      Effect.gen(function* () {
        const ada = yield* jsonAs("ada");

        const before = yield* ada.postMessage({
          room: "design",
          text: "Before the JSON watch.",
        });

        const received: unknown[] = [];

        yield* ada
          .watch(
            MessagePosted,
            { room: "design" },
            { cursor: String(before.id) }
          )
          .pipe(
            Stream.filter((item) => item._tag === "Occurrence"),
            Stream.runForEach((item) => Effect.sync(() => received.push(item))),
            Effect.forkScoped
          );

        const first = yield* ada.postMessage({
          room: "design",
          text: "While the JSON watch runs.",
        });

        yield* arrivedIn(received)(1);
        yield* evict("Room", "design");

        const second = yield* ada.postMessage({
          room: "design",
          text: "After the room's eviction, on the same watch.",
        });

        yield* arrivedIn(received)(2);

        expect(received).toMatchObject([{ data: first }, { data: second }]);
      }).pipe(Effect.scoped, Effect.provide(worker)),
    { timeout: 60_000 }
  );

  it.live(
    "costs each post 1 + T + P stub calls with two pages watching: the post, its tellLobby and the lobby's roomChanged, its expire on an hour's first post, and one re-poll a page",
    () =>
      Effect.gen(function* () {
        const page = yield* openRoom(baseUrl, "general", "ada");
        const received: unknown[] = [];

        const watching = (socket: ReturnType<typeof socketTo>) =>
          Effect.flatMap(Layer.build(socket), (context) =>
            followRoom("general", "ada").pipe(
              Effect.flatMap((messages) =>
                messages(0).pipe(
                  Stream.runForEach((item) =>
                    Effect.sync(() => received.push(item))
                  ),
                  Effect.forkScoped
                )
              ),
              Effect.provideContext(context)
            )
          );

        yield* watching(socketTo("general"));
        yield* watching(socketTo("general"));
        yield* parkedIn("general", 2);
        yield* sqlIn(
          "Room",
          "general",
          "UPDATE messages SET at = at - ?",
          day / 24
        );

        const posts = [
          { text: "Counted, the first.", evicted: false },
          { text: "Counted, after an eviction.", evicted: true },
          { text: "Counted, the third.", evicted: false },
          { text: "Counted, after another eviction.", evicted: true },
        ];

        const outcomes = yield* Effect.forEach(posts, ({ text, evicted }) =>
          Effect.gen(function* () {
            if (evicted) {
              yield* evict("Room", "general");
            }

            const latest = yield* lastPostedAt("general");
            const before = yield* settledStubCalls;
            const arrived = received.length;
            const posted = yield* page.post(text);

            yield* arrivedIn(received)(arrived + 2);
            yield* parkedIn("general", 2);

            const after = yield* settledStubCalls;

            const expires =
              latest === null || windowOf(latest) !== windowOf(posted.at);

            return {
              calls: counted(after.invokes.slice(before.invokes.length)),
              others: {
                hold: after.others.hold - before.others.hold,
                acknowledge:
                  after.others.acknowledge - before.others.acknowledge,
              },
              expected: {
                "Room/general postMessage": 1,
                "Room/general tellLobby": 1,
                "Lobby/lobby roomChanged": 1,
                "Room/general message.posted": 2,
                ...(expires ? { "Room/general expire": 1 } : {}),
              },
            };
          })
        );

        const [first] = outcomes;

        expect(
          Object.values(first?.calls ?? {}).reduce((sum, n) => sum + n, 0)
        ).toBe(6);

        for (const { calls, others, expected } of outcomes) {
          expect(calls).toStrictEqual(expected);
          expect(others).toStrictEqual({ hold: 0, acknowledge: 0 });
        }
      }).pipe(Effect.scoped, Effect.provide(worker)),
    { timeout: 120_000 }
  );

  it.live(
    "serves both rooms over one MCP connection, each tool answering from its own room",
    () =>
      Effect.gen(function* () {
        const ada = yield* agentAs("ada");

        const general = yield* ada.postMessage({
          room: "general",
          text: "Polled in general.",
        });

        const design = yield* ada.postMessage({
          room: "design",
          text: "Polled in design.",
        });

        const polled = (room: DemoRoomName, after: number) =>
          ada
            .watch(
              MessagePosted,
              { room },
              { mode: "poll", cursor: String(after) }
            )
            .pipe(Stream.take(1), Stream.runCollect);

        expect(yield* polled("general", general.id - 1)).toMatchObject([
          { _tag: "Occurrence", data: general },
        ]);
        expect(yield* polled("design", design.id - 1)).toMatchObject([
          { _tag: "Occurrence", data: design },
        ]);

        const grace = yield* agentAs("grace");

        expect(
          yield* Effect.flip(
            grace.postMessage({ room: "design", text: "Not a member." })
          )
        ).toBeInstanceOf(Action.Forbidden);
      }).pipe(Effect.scoped, Effect.provide(worker)),
    { timeout: 30_000 }
  );

  it.live(
    "shows both rooms' latest posts in the lobby once their persisted tells land, and keeps no credential in any mailbox",
    () =>
      Effect.gen(function* () {
        const json = yield* jsonAs("ada");

        const general = yield* json.postMessage({
          room: "general",
          text: "Seen from the lobby.",
        });

        const design = yield* json.postMessage({
          room: "design",
          text: "Seen from the lobby too.",
        });

        const lobby = yield* ActionHttp.client(LobbyHttp, { baseUrl });

        const { previews } = yield* eventually(lobby.previews(), (answer) =>
          answer.previews.every(
            ({ room, latestAt }) =>
              latestAt === (room === "general" ? general.at : design.at)
          )
        );

        expect(previews).toStrictEqual([
          { room: "general", latestAt: general.at },
          { room: "design", latestAt: design.at },
        ]);

        const mailboxes = [
          ...(yield* rowsIn(
            "Room",
            "general",
            "SELECT * FROM cluster_messages"
          )),
          ...(yield* rowsIn(
            "Room",
            "design",
            "SELECT * FROM cluster_messages"
          )),
          ...(yield* rowsIn(
            "Lobby",
            "lobby",
            "SELECT * FROM cluster_messages"
          )),
        ];

        expect(mailboxes.some((row) => row.includes("tellLobby"))).toBe(true);
        expect(mailboxes.some((row) => row.includes("expire"))).toBe(true);

        for (const row of mailboxes) {
          expect(row).not.toContain("authorization");
          expect(row).not.toContain("Bearer");
        }
      }).pipe(Effect.provide(worker)),
    { timeout: 30_000 }
  );

  it.live(
    "sends a page following the lobby, signed out, the previews at once, then whole at each change",
    () =>
      Effect.gen(function* () {
        const grace = yield* jsonAs("grace");

        const { messages } = yield* grace.readMessages({
          room: "general",
          after: 0,
        });

        const before = messages.at(-1)?.at ?? null;

        const received: Array<
          ReadonlyArray<{ room: string; latestAt: number | null }>
        > = [];

        yield* Effect.flatMap(followLobby(baseUrl), (previews) =>
          Stream.runForEach(previews, (each) =>
            Effect.sync(() => received.push(each))
          )
        ).pipe(Effect.forkScoped);

        yield* arrivedIn(received)(1);

        const posted = yield* grace.postMessage({
          room: "general",
          text: "Seen by the lobby's pages.",
        });

        yield* eventually(
          Effect.sync(() => received.map(generalIn)),
          (seen) => seen.includes(posted.at)
        );

        expect(received[0]?.length).toBe(2);
        expect(generalIn(received[0] ?? [])).toBe(before);
        expect(received.map(generalIn)).toContain(posted.at);
      }).pipe(Effect.scoped, Effect.provide(worker)),
    { timeout: 30_000 }
  );

  it.live(
    "deletes a day-old message when its expiry tell is delivered",
    () =>
      Effect.gen(function* () {
        const json = yield* jsonAs("ada");

        const posted = yield* json.postMessage({
          room: "design",
          text: "Gone in a day.",
        });

        yield* sqlIn(
          "Room",
          "design",
          "UPDATE messages SET at = at - ? WHERE id = ?",
          day,
          posted.id
        );
        yield* deliverNow("Room", "design", "expire");

        const { messages } = yield* eventually(
          json.readMessages({ room: "design", after: posted.id - 1 }),
          (read) => read.messages.length === 0
        );

        expect(messages).toStrictEqual([]);
      }).pipe(Effect.provide(worker)),
    { timeout: 30_000 }
  );

  it.live(
    "answers another Worker's call of RoomsEntrypoint as the lobby keeps it, and refuses a room it does not list",
    () =>
      Effect.gen(function* () {
        const posted = yield* (yield* jsonAs("grace")).postMessage({
          room: "general",
          text: "Seen from another Worker.",
        });

        const refused = yield* Effect.flip(
          Effect.tryPromise(
            async () => await exports.RoomsEntrypoint.latestAt("kitchen")
          )
        );

        const latestAt = yield* eventually(
          Effect.promise(
            async () => await exports.RoomsEntrypoint.latestAt("general")
          ),
          (at) => at === posted.at
        );

        expect(latestAt).toBe(posted.at);
        expect(String(refused.cause)).toContain(
          'Expected "general" | "design"'
        );
      }).pipe(Effect.provide(worker)),
    { timeout: 30_000 }
  );

  it.live(
    "tells itself to expire again a minute later when an expiry fails, and expires the day-old message then",
    () =>
      Effect.gen(function* () {
        const json = yield* jsonAs("ada");

        const posted = yield* json.postMessage({
          room: "general",
          text: "Expired on the second try.",
        });

        yield* sqlIn(
          "Room",
          "general",
          "UPDATE messages SET at = at - ? WHERE id = ?",
          day,
          posted.id
        );

        yield* failing(
          "Room",
          "general",
          "CREATE TRIGGER planted_failure BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT, 'planted'); END"
        );

        const failedAt = Date.now();

        yield* expireNow("general");

        yield* retryOf("general", "expire", failedAt + 30_000);

        expect(
          (yield* json.readMessages({ room: "general", after: posted.id - 1 }))
            .messages
        ).toStrictEqual([{ ...posted, at: posted.at - day }]);

        yield* sqlIn("Room", "general", "DROP TRIGGER planted_failure");
        yield* deliverNow("Room", "general", "retry");

        const { messages } = yield* eventually(
          json.readMessages({ room: "general", after: posted.id - 1 }),
          (read) => read.messages.length === 0
        );

        expect(messages).toStrictEqual([]);
      }).pipe(Effect.scoped, Effect.provide(worker)),
    { timeout: 30_000 }
  );

  it.live(
    "tells the lobby of a change after a failed ask at once, the failed ask's retry still pending",
    () =>
      Effect.gen(function* () {
        const json = yield* jsonAs("ada");
        const lobby = yield* ActionHttp.client(LobbyHttp, { baseUrl });

        yield* lobby.previews();

        yield* failing(
          "Lobby",
          "lobby",
          "CREATE TRIGGER planted_failure BEFORE INSERT ON previews BEGIN SELECT RAISE(ABORT, 'planted'); END"
        );

        const failedAt = Date.now();

        yield* json.postMessage({
          room: "design",
          text: "Missed by the lobby.",
        });

        yield* retryOf("design", "tellLobby", failedAt + 30_000);

        yield* sqlIn("Lobby", "lobby", "DROP TRIGGER planted_failure");

        const posted = yield* json.postMessage({
          room: "design",
          text: "Shown with no retry.",
        });

        yield* eventually(lobby.previews(), (answer) =>
          answer.previews.some(
            ({ room, latestAt }) => room === "design" && latestAt === posted.at
          )
        );

        expect(
          (yield* tellsOf("Room", "design", "retry")).filter(
            ({ processed, task, deliver_at }) =>
              processed === 0 &&
              task === "tellLobby" &&
              (deliver_at ?? 0) > failedAt + 30_000
          )
        ).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(worker)),
    { timeout: 30_000 }
  );

  it.live(
    "answers a post the lobby fails to record, tells the lobby again a minute later, and shows the post then",
    () =>
      Effect.gen(function* () {
        const json = yield* jsonAs("ada");
        const lobby = yield* ActionHttp.client(LobbyHttp, { baseUrl });

        yield* lobby.previews();

        yield* failing(
          "Lobby",
          "lobby",
          "CREATE TRIGGER planted_failure BEFORE INSERT ON previews BEGIN SELECT RAISE(ABORT, 'planted'); END"
        );

        const failedAt = Date.now();

        const posted = yield* json.postMessage({
          room: "design",
          text: "Recorded on the second try.",
        });

        yield* retryOf("design", "tellLobby", failedAt + 30_000);

        expect(
          (yield* json.readMessages({ room: "design", after: posted.id - 1 }))
            .messages
        ).toStrictEqual([posted]);
        expect(
          (yield* lobby.previews()).previews.find(
            ({ room }) => room === "design"
          )?.latestAt
        ).not.toBe(posted.at);

        yield* sqlIn("Lobby", "lobby", "DROP TRIGGER planted_failure");
        yield* deliverNow("Room", "design", "retry");

        const { previews } = yield* eventually(lobby.previews(), (answer) =>
          answer.previews.some(
            ({ room, latestAt }) => room === "design" && latestAt === posted.at
          )
        );

        expect(previews).toContainEqual({
          room: "design",
          latestAt: posted.at,
        });
      }).pipe(Effect.scoped, Effect.provide(worker)),
    { timeout: 30_000 }
  );
  it.live(
    "keeps one pending retry a minute while the lobby fails, however many changes and activations of the room it misses",
    () =>
      Effect.gen(function* () {
        const json = yield* jsonAs("ada");

        yield* failing(
          "Lobby",
          "lobby",
          "CREATE TRIGGER planted_failure BEFORE INSERT ON previews BEGIN SELECT RAISE(ABORT, 'planted'); END"
        );

        const failedAt = Date.now();

        const posted = yield* Effect.forEach(
          Array.from({ length: 4 }, (_, n) => n),
          (n) =>
            Effect.gen(function* () {
              yield* evict("Room", "general");

              const message = yield* json.postMessage({
                room: "general",
                text: `Missed ${n + 1}.`,
              });

              yield* Effect.sleep("1100 millis");

              return message;
            })
        );

        const last = posted.at(-1)?.at ?? failedAt;

        expect(last - (posted[0]?.at ?? last)).toBeGreaterThan(3000);

        yield* retryOf("general", "tellLobby", failedAt + 30_000);

        yield* eventually(
          Effect.map(tellsOf("Room", "general", "tellLobby"), (tells) =>
            tells.filter(({ processed }) => processed === 0)
          ),
          (pending) => pending.length === 0
        );

        const retries = (yield* tellsOf("Room", "general", "retry")).filter(
          ({ processed, task, deliver_at }) =>
            processed === 0 &&
            task === "tellLobby" &&
            (deliver_at ?? 0) > failedAt
        );

        expect(retries.length).toBeGreaterThan(0);
        expect(retries.length).toBeLessThanOrEqual(2);

        yield* evict("Room", "general");
      }).pipe(Effect.scoped, Effect.provide(worker)),
    { timeout: 30_000 }
  );

  it.live(
    "polls a room over one MCP connection across the room's eviction",
    () =>
      Effect.gen(function* () {
        const ada = yield* agentAs("ada");

        const polled = (after: number) =>
          ada
            .watch(
              MessagePosted,
              { room: "design" },
              { mode: "poll", cursor: String(after) }
            )
            .pipe(Stream.take(1), Stream.runCollect);

        const before = yield* ada.postMessage({
          room: "design",
          text: "Before the eviction.",
        });

        expect(yield* polled(before.id - 1)).toMatchObject([
          { _tag: "Occurrence", data: before },
        ]);

        yield* evict("Room", "design");

        const after = yield* ada.postMessage({
          room: "design",
          text: "After the eviction.",
        });

        expect(yield* polled(before.id)).toMatchObject([
          { _tag: "Occurrence", data: after },
        ]);
      }).pipe(Effect.scoped, Effect.provide(worker)),
    { timeout: 30_000 }
  );

  it.live(
    "schedules one expiry for the posts of one hour's window, and the expiry the next window",
    () =>
      Effect.gen(function* () {
        const json = yield* jsonAs("ada");

        const posted = yield* Effect.forEach([1, 2, 3], (n) =>
          json.postMessage({ room: "general", text: `In one window, ${n}.` })
        );

        const windows = new Set(posted.map(({ at }) => windowOf(at)));

        const scheduled = (yield* tellsOf("Room", "general", "expire")).filter(
          ({ at }) => at !== null && windows.has(at)
        );

        expect(scheduled).toHaveLength(windows.size);

        const later = 2 * 60 * 60 * 1000;

        yield* sqlIn(
          "Room",
          "general",
          "UPDATE messages SET at = at + ?",
          later
        );

        const { messages } = yield* json.readMessages({
          room: "general",
          after: 0,
        });

        const next = windowOf(Math.min(...messages.map(({ at }) => at)));

        yield* expireNow("general");

        const nexts = yield* eventually(
          Effect.map(tellsOf("Room", "general", "expire"), (tells) =>
            tells.filter(({ at }) => at === next)
          ),
          (found) => found.length > 0
        );

        expect(nexts).toMatchObject([{ processed: 0, deliver_at: next }]);
      }).pipe(Effect.provide(worker)),
    { timeout: 30_000 }
  );

  it.live(
    "retries a failing expiry, each wait twice the last up to an hour, and expires the day-old message once it succeeds",
    () =>
      Effect.gen(function* () {
        const json = yield* jsonAs("ada");

        const kept = yield* json.postMessage({
          room: "design",
          text: "Expired once the store recovers.",
        });

        yield* sqlIn(
          "Room",
          "design",
          "UPDATE messages SET at = at - ? WHERE id = ?",
          day,
          kept.id
        );

        yield* failing(
          "Room",
          "design",
          "CREATE TRIGGER planted_failure BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT, 'planted'); END"
        );

        const pendingExpiries = Effect.map(
          tellsOf("Room", "design", "retry"),
          (tells) =>
            tells.filter(
              ({ processed, task }) => processed === 0 && task === "expire"
            )
        );

        const minute = 60_000;

        const alignedToTheMinute = (at: number) =>
          Math.ceil(at / minute) * minute;

        for (const [attempt, wait] of [1, 2, 4, 8, 16, 32, 60].entries()) {
          const deliveredAt = Date.now();

          yield* attempt === 0
            ? expireNow("design")
            : deliverNow("Room", "design", "retry");

          const [retry] = yield* eventually(
            Effect.map(pendingExpiries, (pending) =>
              pending.filter((tell) => tell.attempt === attempt + 1)
            ),
            (found) => found.length > 0
          );

          const foundAt = Date.now();

          expect(retry?.deliver_at).toBeGreaterThanOrEqual(
            alignedToTheMinute(deliveredAt + wait * minute)
          );
          expect(retry?.deliver_at).toBeLessThanOrEqual(
            alignedToTheMinute(foundAt + wait * minute)
          );
        }

        yield* sqlIn("Room", "design", "DROP TRIGGER planted_failure");
        yield* deliverNow("Room", "design", "retry");

        yield* eventually(pendingExpiries, (pending) => pending.length === 0);

        expect(
          (yield* json.readMessages({ room: "design", after: kept.id - 1 }))
            .messages
        ).toStrictEqual([]);
      }).pipe(Effect.scoped, Effect.provide(worker)),
    { timeout: 30_000 }
  );

  it.live(
    "expires a post and tells the lobby of it when the post fails after its write",
    () =>
      Effect.gen(function* () {
        const json = yield* jsonAs("ada");
        const lobby = yield* ActionHttp.client(LobbyHttp, { baseUrl });

        const last = yield* json.readMessages({ room: "general", after: 0 });
        const after = last.messages.at(-1)?.id ?? 0;

        yield* failing(
          "Room",
          "general",
          "CREATE TRIGGER planted_failure BEFORE INSERT ON effect_actions_event_revision BEGIN SELECT RAISE(ABORT, 'planted'); END"
        );

        const failed = yield* Effect.flip(
          json.postMessage({
            room: "general",
            text: "Written before the post failed.",
          })
        );

        expect(failed).toBeDefined();

        const [written] = (yield* json.readMessages({ room: "general", after }))
          .messages;

        expect(written?.text).toBe("Written before the post failed.");

        yield* eventually(lobby.previews(), (answer) =>
          answer.previews.some(
            ({ room, latestAt }) =>
              room === "general" && latestAt === written?.at
          )
        );

        expect(
          (yield* tellsOf("Room", "general", "expire")).filter(
            ({ at }) => written !== undefined && at === windowOf(written.at)
          )
        ).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(worker)),
    { timeout: 30_000 }
  );

  it.live(
    "sends a page following the lobby a change whose announcement failed once it is recorded again",
    () =>
      Effect.gen(function* () {
        const json = yield* jsonAs("grace");

        const received: Array<
          ReadonlyArray<{ room: string; latestAt: number | null }>
        > = [];

        yield* Effect.flatMap(followLobby(baseUrl), (previews) =>
          Stream.runForEach(previews, (each) =>
            Effect.sync(() => received.push(each))
          )
        ).pipe(Effect.forkScoped);

        yield* arrivedIn(received)(1);

        yield* failing(
          "Lobby",
          "lobby",
          "CREATE TRIGGER planted_failure BEFORE INSERT ON effect_actions_event_revision BEGIN SELECT RAISE(ABORT, 'planted'); END"
        );

        const failedAt = Date.now();

        const posted = yield* json.postMessage({
          room: "general",
          text: "Announced on the second try.",
        });

        yield* retryOf("general", "tellLobby", failedAt + 30_000);

        expect(received.map(generalIn)).not.toContain(posted.at);

        yield* sqlIn("Lobby", "lobby", "DROP TRIGGER planted_failure");
        yield* deliverNow("Room", "general", "retry");

        yield* eventually(
          Effect.sync(() => received.map(generalIn)),
          (seen) => seen.includes(posted.at)
        );

        expect(received.map(generalIn)).toContain(posted.at);
      }).pipe(Effect.scoped, Effect.provide(worker)),
    { timeout: 30_000 }
  );

  it.live(
    "keeps the preview of a room's highest version, whatever order its changes arrive in",
    () =>
      Effect.gen(function* () {
        const from = (yield* versionIn("design")) + 1;

        const versions = [7, 2, 19, 0, 11, 5, 16, 3, 13, 9];

        yield* inApplication(
          Effect.flatMap(Lobby.client, (lobbies) =>
            Effect.forEach(versions, (offset) =>
              lobbies("lobby").roomChanged({
                preview: { room: "design", latestAt: from + offset },
                version: from + offset,
              })
            )
          )
        );

        yield* sqlIn(
          "Room",
          "design",
          "UPDATE room_version SET version = ?",
          from + Math.max(...versions)
        );

        const lobby = yield* ActionHttp.client(LobbyHttp, { baseUrl });

        expect(
          (yield* lobby.previews()).previews.find(
            ({ room }) => room === "design"
          )?.latestAt
        ).toBe(from + Math.max(...versions));
      }).pipe(Effect.provide(worker)),
    { timeout: 30_000 }
  );

  it.live(
    "answers a room's posts, and its reads within 2.5 seconds each behind one change's ask, while the lobby takes no call, and shows the latest change it was asked once it takes calls again",
    () =>
      Effect.gen(function* () {
        const json = yield* jsonAs("ada");
        const lobby = yield* ActionHttp.client(LobbyHttp, { baseUrl });

        yield* json.postMessage({ room: "general", text: "Before the hang." });

        const hanging = yield* Effect.forkChild(
          Effect.promise(async () => {
            await runInDurableObject(
              objectOf("Lobby", "lobby"),
              async (_, state) => {
                await state.blockConcurrencyWhile(async () => {
                  await scheduler.wait(8000);
                });
              }
            );
          })
        );

        yield* Effect.sleep("200 millis");

        const calls = yield* Effect.forEach([1, 2], (n) =>
          Effect.all([
            timed(json.postMessage({ room: "general", text: `Hung ${n}.` })),
            timed(json.readMessages({ room: "general", after: 0 })),
          ])
        );

        for (const [post, read] of calls) {
          expect(post.took).toBeLessThan(2500);
          expect(read.took).toBeLessThan(2500);
        }

        yield* Fiber.join(hanging);

        const last = calls.at(-1)?.[0].value.at;

        yield* eventually(
          lobby.previews(),
          ({ previews }) => generalIn(previews) === last
        );
      }).pipe(Effect.provide(worker)),
    { timeout: 30_000 }
  );
});
