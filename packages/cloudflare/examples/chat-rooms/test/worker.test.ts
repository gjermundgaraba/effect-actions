import * as CloudflareCluster from "@effect/platform-cloudflare/CloudflareCluster";
import { describe, expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { Effect, Layer, Schedule, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Socket } from "effect/socket";

import { RoomHttp } from "../src/Api.js";
import { initialize } from "../src/application.js";
import { followRoom, openRoom, overSocket } from "../src/browser.js";
import { MessagePosted, PostMessage } from "../src/chat/Chat.js";
import type { DemoRoomName } from "../src/chat/Chat.js";
import { Room } from "../src/entities.js";
import { Login } from "../src/identity/Identity.js";
import { protocolVersion } from "../src/Rpc.js";
import { baseUrl, evict, objectOf, rowsIn, sqlIn, worker } from "./support.js";

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

const failing = (type: string, id: string, trigger: string) =>
  Effect.acquireRelease(sqlIn(type, id, trigger), () =>
    sqlIn(type, id, "DROP TRIGGER IF EXISTS planted_failure")
  );

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
    "costs each post 1 + P stub calls with two pages watching: the post, and one re-poll a page",
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

        const posts = [
          { text: "Counted, the first.", evicted: false },
          { text: "Counted, after an eviction.", evicted: true },
        ];

        const outcomes = yield* Effect.forEach(posts, ({ text, evicted }) =>
          Effect.gen(function* () {
            if (evicted) {
              yield* evict("Room", "general");
            }

            const before = yield* settledStubCalls;
            const arrived = received.length;

            yield* page.post(text);
            yield* arrivedIn(received)(arrived + 2);
            yield* parkedIn("general", 2);

            const after = yield* settledStubCalls;

            return {
              calls: counted(after.invokes.slice(before.invokes.length)),
              others: {
                hold: after.others.hold - before.others.hold,
                acknowledge:
                  after.others.acknowledge - before.others.acknowledge,
              },
            };
          })
        );

        for (const { calls, others } of outcomes) {
          expect(calls).toStrictEqual({
            "Room/general postMessage": 1,
            "Room/general message.posted": 2,
          });
          expect(others).toStrictEqual({ hold: 0, acknowledge: 0 });
        }
      }).pipe(Effect.scoped, Effect.provide(worker)),
    { timeout: 60_000 }
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
    "sends a page's post once when the room fails it, sending again only after a transport failure",
    () =>
      Effect.gen(function* () {
        const page = yield* openRoom(baseUrl, "general", "ada");

        yield* page.post("Before the room fails.");

        yield* failing(
          "Room",
          "general",
          "CREATE TRIGGER planted_failure BEFORE INSERT ON effect_actions_event_revision BEGIN SELECT RAISE(ABORT, 'planted'); END"
        );

        const before = yield* settledStubCalls;

        yield* Effect.flip(page.post("Failed by the room."));

        const after = yield* settledStubCalls;

        expect(
          counted(after.invokes.slice(before.invokes.length))[
            "Room/general postMessage"
          ]
        ).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(worker)),
    { timeout: 30_000 }
  );

  it.live(
    "posts a message once when its first try fails after the write and the page sends it again with its request",
    () =>
      Effect.gen(function* () {
        const json = yield* jsonAs("ada");

        const sent = {
          room: "general",
          text: "Failed after its write, then sent again.",
          request: crypto.randomUUID(),
        } as const;

        const last = yield* json.readMessages({ room: "general", after: 0 });
        const after = last.messages.at(-1)?.id ?? 0;

        yield* failing(
          "Room",
          "general",
          "CREATE TRIGGER planted_failure BEFORE INSERT ON effect_actions_event_revision BEGIN SELECT RAISE(ABORT, 'planted'); END"
        );

        yield* Effect.flip(json.postMessage(sent));

        yield* sqlIn("Room", "general", "DROP TRIGGER planted_failure");

        const posted = yield* json.postMessage(sent);

        const { messages } = yield* json.readMessages({
          room: "general",
          after,
        });

        expect(messages).toStrictEqual([posted]);
      }).pipe(Effect.scoped, Effect.provide(worker)),
    { timeout: 30_000 }
  );
});
