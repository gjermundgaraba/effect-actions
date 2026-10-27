import { describe, expect, it } from "@effect/vitest";
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionMcp from "@gjermundgaraba/effect-actions/ActionMcp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import type { Schema } from "effect";
import { DateTime, Effect, Schedule, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { TestClock } from "effect/testing";

import { LobbyHttp, RoomHttp } from "../src/Api.js";
import { followLobby, openRoom } from "../src/browser.js";
import { MessagePosted, PostMessage } from "../src/chat/Chat.js";
import type { RoomName } from "../src/chat/Chat.js";
import { Login } from "../src/identity/Identity.js";
import { RoomRpc, unsupportedProtocol } from "../src/Rpc.js";
import { pageSocket, roomSocket } from "./support/socket.js";

const day = 24 * 60 * 60 * 1000;

// Every request goes through the Worker's own `fetch`, as a deployed one would get it.
const worker = ActionDurableObject.layerHttpClient(exports.default);

// The rooms' JSON routes, the Worker's: each call names its room.
const jsonAs = (token?: string) =>
  ActionHttp.client(RoomHttp, {
    baseUrl: "https://chat.example",
    ...(token === undefined
      ? {}
      : {
          transformClient: HttpClient.mapRequest(
            HttpClientRequest.bearerToken(token)
          ),
        }),
  });

// An agent's one connection to the Worker's MCP endpoint, reaching every room.
const agentAs = (token: string) =>
  ActionMcp.client([PostMessage, MessagePosted], {
    url: "https://chat.example/mcp",
    authentication: Login,
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.bearerToken(token)
    ),
  });

// What the runtime does after a call answers, such as a room's alarm, is waited for in real time:
// a test using this runs under `it.live`, as under the test clock its sleeps never pass.
const eventually = <A, E>(
  check: Effect.Effect<A, E>,
  until: (value: A) => boolean
) =>
  check.pipe(
    Effect.repeat({ until, schedule: Schedule.spaced("10 millis") }),
    Effect.timeout("5 seconds")
  );

const arrivedIn = (received: readonly unknown[]) => (count: number) =>
  eventually(
    Effect.sync(() => received.length),
    (length) => length >= count
  );

const pageIn = (
  room: RoomName,
  token: string,
  headers: Record<string, string> = {}
) =>
  Effect.flatMap(roomSocket(room, headers), ({ protocol }) =>
    Effect.provideContext(openRoom(room, token), protocol)
  );

const generalIn = (
  previews: ReadonlyArray<{ room: string; latestAt: number | null }>
) => previews.find(({ room }) => room === "general")?.latestAt;

const status = (path: string, body: Schema.Json = {}) =>
  Effect.promise(
    async () =>
      await exports.default.fetch(`https://chat.example${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer ada",
        },
        body: JSON.stringify(body),
      })
  ).pipe(Effect.map((response) => response.status));

const readAll = (room: string) => ({ room, after: 0 });

// First in the file, whose Worker module is its own: no request has reached the lobby before, so
// a first request ending without I/O is the one that would strand a client built inside it, as
// `ActionDurableObject.layerStubClient`'s gotchas say.
describe("the Worker's handler, built as the module loads", () => {
  it.effect(
    "answers a first request ending without I/O, then a call reaching the lobby",
    () =>
      Effect.gen(function* () {
        const missing = yield* Effect.promise(
          async () =>
            await exports.default.fetch("https://chat.example/missing")
        );

        const lobby = yield* ActionHttp.client(LobbyHttp, {
          baseUrl: "https://chat.example",
        });

        const { previews } = yield* lobby.previews();

        expect(missing.status).toBe(404);
        expect(previews.map(({ room }) => room)).toStrictEqual([
          "general",
          "design",
        ]);
      }).pipe(Effect.provide(worker))
  );
});

describe("the Worker and its rooms", () => {
  it.effect(
    "serves a room's page over its socket, the token on each message",
    () =>
      Effect.gen(function* () {
        const room = yield* pageIn("design", "ada");
        const posted = yield* room.post("Mock-ups are up.");

        expect(yield* room.read(posted.id - 1)).toStrictEqual([posted]);
        expect(yield* room.remove(posted.id)).toBe("removed");
      }).pipe(Effect.scoped)
  );

  it.effect(
    "reads the messages posted after an id, over a socket or JSON",
    () =>
      Effect.gen(function* () {
        const reader = yield* pageIn("general", "ada");
        const writer = yield* pageIn("general", "ada");
        const json = yield* jsonAs("ada");
        const first = yield* writer.post("Over a socket.");

        const second = yield* json.postMessage({
          room: "general",
          text: "Over the JSON routes.",
        });

        expect(yield* reader.read(first.id - 1)).toStrictEqual([first, second]);
        expect(yield* reader.read(first.id)).toStrictEqual([second]);
      }).pipe(Effect.scoped, Effect.provide(worker))
  );

  it.effect(
    "posts a message sent again with its request once, answering the repeat as the first",
    () =>
      Effect.gen(function* () {
        const reader = yield* pageIn("general", "ada");
        const json = yield* jsonAs("ada");

        const sent = {
          room: "general",
          text: "Sent twice.",
          request: crypto.randomUUID(),
        } as const;

        const first = yield* json.postMessage(sent);

        expect(yield* json.postMessage(sent)).toStrictEqual(first);
        expect(yield* reader.read(first.id - 1)).toStrictEqual([first]);
      }).pipe(Effect.scoped, Effect.provide(worker))
  );

  it.effect(
    "refuses a page built for another version of the rpcs, closing its socket with the code it reads, which stops its client connecting again",
    () =>
      Effect.gen(function* () {
        const { protocol, connects } = yield* roomSocket("general", {}, "0");

        const page = yield* Effect.provideContext(
          openRoom("general", "ada"),
          protocol
        );

        const refused = yield* Effect.flip(page.read(0));

        yield* TestClock.adjust("1 minute");

        expect(refused).toMatchObject({
          _tag: "RpcClientError",
          reason: { _tag: "SocketCloseError", code: unsupportedProtocol },
        });
        expect(connects()).toBe(1);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "authenticates a socket's messages by the token of its upgrade, after eviction",
    () =>
      Effect.gen(function* () {
        const { protocol } = yield* roomSocket("design", {
          authorization: "Bearer ada",
        });

        const client = yield* Effect.provideContext(
          ActionRpc.client(RoomRpc),
          protocol
        );

        const posted = yield* client.postMessage({
          room: "design",
          text: "Before the eviction.",
        });

        yield* Effect.promise(async () => {
          await evictDurableObject(env.CHAT_ROOM.getByName("design"));
        });

        const read = yield* client.readMessages({
          room: "design",
          after: posted.id - 1,
        });

        const anonymous = yield* jsonAs().pipe(
          Effect.flatMap((json) =>
            Effect.flip(
              json.postMessage({ room: "design", text: "Anonymous." })
            )
          )
        );

        expect(read.messages).toStrictEqual([posted]);
        expect(anonymous).toBeInstanceOf(Action.Unauthenticated);
      }).pipe(Effect.scoped, Effect.provide(worker))
  );

  it.live(
    "follows a room through MessagePosted from the last id a page read, across the object's eviction",
    () =>
      Effect.gen(function* () {
        const reader = yield* pageIn("design", "ada");
        const writer = yield* pageIn("design", "ada");
        const json = yield* jsonAs("ada");
        const before = yield* writer.post("Before the page opened.");
        const read = yield* reader.read(before.id - 1);
        const after = read.at(-1)?.id ?? 0;

        const received: unknown[] = [];

        yield* reader.messages(after).pipe(
          Stream.runForEach((item) => Effect.sync(() => received.push(item))),
          Effect.forkScoped
        );

        const arrived = arrivedIn(received);

        const first = yield* writer.post("Read as the watch starts.");

        yield* arrived(1);

        const second = yield* writer.post(
          "Over a socket, while the page watches."
        );

        yield* arrived(2);
        yield* Effect.promise(async () => {
          await evictDurableObject(env.CHAT_ROOM.getByName("design"));
        });

        const third = yield* json.postMessage({
          room: "design",
          text: "Over the JSON routes, after a sleep.",
        });

        yield* arrived(3);

        expect(read).toStrictEqual([before]);
        expect(received).toMatchObject([
          { _tag: "Occurrence", data: first },
          { _tag: "Occurrence", data: second },
          { _tag: "Occurrence", data: third },
        ]);
      }).pipe(Effect.scoped, Effect.provide(worker))
  );

  it.live(
    "serves every room over one MCP connection: a post and a poll in each, across an eviction, and a member outside a room refused",
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

        const polled = (room: RoomName, after: number) =>
          ada
            .watch(
              MessagePosted,
              { room },
              { mode: "poll", cursor: String(after) }
            )
            .pipe(
              Stream.take(1),
              Stream.runCollect,
              Effect.timeout("5 seconds")
            );

        const fromGeneral = yield* polled("general", general.id - 1);

        yield* Effect.promise(async () => {
          await evictDurableObject(env.CHAT_ROOM.getByName("design"));
        });

        const fromDesign = yield* polled("design", design.id - 1);
        const grace = yield* agentAs("grace");

        const refused = yield* Effect.flip(
          grace.postMessage({ room: "design", text: "Not a member." })
        );

        expect(fromGeneral).toMatchObject([
          { _tag: "Occurrence", data: general },
        ]);
        expect(fromDesign).toMatchObject([
          { _tag: "Occurrence", data: design },
        ]);
        expect(refused).toBeInstanceOf(Action.Forbidden);
      }).pipe(Effect.scoped, Effect.provide(worker))
  );

  it.effect(
    "refuses, in a room's object, a call on its socket naming another room",
    () =>
      Effect.gen(function* () {
        const { protocol } = yield* roomSocket("design", {
          authorization: "Bearer ada",
        });

        const client = yield* Effect.provideContext(
          ActionRpc.client(RoomRpc),
          protocol
        );

        const refused = yield* Effect.flip(
          client.postMessage({
            room: "general",
            text: "Through the wrong room.",
          })
        );

        expect(refused).toBeInstanceOf(Action.Forbidden);
        expect(refused.message).toContain("names general");
      }).pipe(Effect.scoped)
  );

  it.effect(
    "refuses a member outside the room, on its socket and on its JSON routes",
    () =>
      Effect.gen(function* () {
        const page = yield* pageIn("design", "grace");
        const json = yield* jsonAs("grace");

        expect(yield* Effect.flip(page.read(0))).toBeInstanceOf(
          Action.Forbidden
        );
        expect(
          yield* Effect.flip(Stream.runDrain(page.messages(0)))
        ).toBeInstanceOf(Action.Forbidden);
        expect(
          yield* Effect.flip(
            json.postMessage({ room: "design", text: "Let me in." })
          )
        ).toBeInstanceOf(Action.Forbidden);
      }).pipe(Effect.scoped, Effect.provide(worker))
  );

  it.effect("refuses to delete another member's message", () =>
    Effect.gen(function* () {
      const ada = yield* pageIn("general", "ada");
      const grace = yield* pageIn("general", "grace");
      const posted = yield* ada.post("Mine.");

      expect(yield* grace.remove(posted.id)).toBe("not-yours");

      expect(yield* grace.read(posted.id - 1)).toStrictEqual([posted]);
    }).pipe(Effect.scoped)
  );

  it.live(
    "answers the lobby's previews as each room told its object, without what was said",
    () =>
      Effect.gen(function* () {
        const json = yield* jsonAs("ada");

        const posted = yield* json.postMessage({
          room: "design",
          text: "Seen from the lobby.",
        });

        const lobby = yield* ActionHttp.client(LobbyHttp, {
          baseUrl: "https://chat.example",
        });

        // The room tells the lobby from its `lobby` task, which the room's alarm runs once the
        // post has answered: the lobby hears of it a moment later, not as the post returns.
        const { previews } = yield* eventually(lobby.previews(), (answer) =>
          answer.previews.some(
            ({ room, latestAt }) => room === "design" && latestAt === posted.at
          )
        );

        expect(previews.map(({ room }) => room)).toStrictEqual([
          "general",
          "design",
        ]);
        expect(previews).toContainEqual({
          room: "design",
          latestAt: posted.at,
        });
      }).pipe(Effect.provide(worker))
  );

  it.live(
    "sends a page following the lobby, signed out, the previews at once, then whole at each change",
    () =>
      Effect.gen(function* () {
        const general = yield* jsonAs("grace");

        const { messages } = yield* general.readMessages({
          room: "general",
          after: 0,
        });

        const before = messages.at(-1)?.at ?? null;
        const { protocol } = yield* pageSocket("/lobby");

        const received: Array<
          ReadonlyArray<{ room: string; latestAt: number | null }>
        > = [];

        yield* Effect.flatMap(followLobby, (previews) =>
          Stream.runForEach(previews, (each) =>
            Effect.sync(() => received.push(each))
          )
        ).pipe(Effect.provideContext(protocol), Effect.forkScoped);

        yield* arrivedIn(received)(1);

        const posted = yield* general.postMessage({
          room: "general",
          text: "Seen by the lobby's pages.",
        });

        yield* arrivedIn(received)(2);
        yield* general.deleteMessage({ room: "general", id: posted.id });
        yield* arrivedIn(received)(3);

        expect(received.map(generalIn)).toStrictEqual([
          before,
          posted.at,
          before,
        ]);
        expect(received.every((previews) => previews.length === 2)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(worker))
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

        // The lobby hears of the post from the room's `lobby` task, a moment after it answered.
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
      }).pipe(Effect.provide(worker))
  );

  it.effect(
    "sends a page's socket alone on to its object, and answers every other path itself, a room it does not list an invalid input",
    () =>
      Effect.gen(function* () {
        expect(yield* status("/api/readMessages", readAll("design"))).toBe(200);
        expect(yield* status("/api/readMessages", readAll("unlisted"))).toBe(
          400
        );
        expect(
          yield* status("/rooms/design/api/readMessages", readAll("design"))
        ).toBe(404);
        expect(yield* status("/rooms/unlisted/rpc")).toBe(404);
        expect(yield* status("/rooms/design//elsewhere.example/rpc")).toBe(404);
      })
  );

  it.live(
    "expires a message a day old when the room's alarm runs, and sets the next",
    () =>
      Effect.gen(function* () {
        const json = yield* jsonAs("ada");
        const stub = env.CHAT_ROOM.getByName("design");

        yield* Effect.promise(async () => {
          await runInDurableObject(stub, (_, state) => {
            state.storage.sql.exec("DELETE FROM messages");
          });
        });

        const old = yield* json.postMessage({
          room: "design",
          text: "From yesterday.",
        });

        const recent = yield* json.postMessage({
          room: "design",
          text: "From today.",
        });

        // A day passes for the first message alone: it is backdated, and the alarm set for its
        // expiry, as its post would have set it a day ago. That time is past, so the runtime runs
        // it at once: the test waits until it has set the next, for the recent one's.
        yield* Effect.promise(async () => {
          await runInDurableObject(stub, async (room, state) => {
            state.storage.sql.exec(
              "UPDATE messages SET at = at - ? WHERE id = ?",
              day,
              old.id
            );

            await room.run(
              ActionDurableObject.Alarm.use((alarm) =>
                alarm.set(DateTime.makeUnsafe(old.at))
              )
            );
          });
        });

        yield* eventually(
          Effect.promise(
            async () =>
              await runInDurableObject(
                stub,
                async (_, state) => await state.storage.getAlarm()
              )
          ),
          (alarm) => alarm === recent.at + day
        );

        expect(yield* (yield* pageIn("design", "ada")).read(0)).toStrictEqual([
          recent,
        ]);
      }).pipe(Effect.scoped, Effect.provide(worker))
  );
});
