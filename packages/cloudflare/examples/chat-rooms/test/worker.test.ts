import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Option, Queue, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { LobbyHttp, RoomHttp } from "../src/Api.js";
import { openRoom } from "../src/browser.js";
import type { Message } from "../src/chat/Chat.js";
import { RoomRpc } from "../src/Rpc.js";
import { roomSocket } from "./support/socket.js";

const day = 24 * 60 * 60 * 1000;

// Every request goes through the Worker's own `fetch`, as a deployed one would get it.
const worker = ActionDurableObject.layerHttpClient(exports.default);

const roomAs = (room: string, token?: string) =>
  ActionHttp.client(RoomHttp, {
    baseUrl: `https://chat.example/rooms/${room}`,
    ...(token === undefined
      ? {}
      : { transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(token)) }),
  });

const pageIn = (room: string, token: string, headers: Record<string, string> = {}) =>
  Effect.flatMap(roomSocket(room, headers), ({ protocol }) =>
    Effect.provideContext(openRoom(token), protocol),
  );

// The chunks of a stream the object sent a page, as the socket carries them.
const chunkOf = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      _tag: Schema.Literal("Chunk"),
      requestId: Schema.Union([Schema.String, Schema.Number]),
    }),
  ),
);

// A page following the room, after `after`: `next(n)` waits for its next `n` messages, `opened`
// for its first, and `closed` for the exit `follow` reported.
const following = (page: Effect.Success<ReturnType<typeof openRoom>>, after: number) =>
  Effect.gen(function* () {
    const rendered = yield* Queue.unbounded<Message>();
    const opened = yield* Deferred.make<void>();
    const closed = yield* Deferred.make<Exit.Exit<void, unknown>>();

    yield* Effect.forkScoped(
      page.follow(after, {
        opened: Deferred.succeed(opened, undefined),
        message: (message) => Queue.offer(rendered, message),
        closed: (exit) => Deferred.succeed(closed, exit),
      }),
    );

    return {
      next: (count: number) => Queue.takeN(rendered, count),
      opened: Deferred.isDone(opened),
      closed: Deferred.await(closed),
    };
  });

describe("the Worker and its rooms", () => {
  it.effect("serves a room's page over its socket, the token on each message", () =>
    Effect.gen(function* () {
      const room = yield* pageIn("design", "ada");
      const posted = yield* room.post("Mock-ups are up.");
      const page = yield* following(room, posted.id - 1);

      expect(yield* page.next(1)).toEqual([posted]);
      expect(yield* room.preview).toBe(posted.at);
      expect(yield* room.remove(posted.id)).toBe("removed");
    }).pipe(Effect.scoped),
  );

  it.effect("sends a following page each message posted after it, over a socket or JSON", () =>
    Effect.gen(function* () {
      const reader = yield* pageIn("general", "ada");
      const writer = yield* pageIn("general", "ada");
      const json = yield* roomAs("general", "ada");
      const first = yield* writer.post("Before the page follows.");
      const page = yield* following(reader, first.id - 1);

      expect(yield* page.next(1)).toEqual([first]);

      const second = yield* writer.post("Over a socket.");
      const third = yield* json.postMessage({ text: "Over the JSON routes." });

      expect(yield* page.next(2)).toEqual([second, third]);
    }).pipe(Effect.scoped, Effect.provide(worker)),
  );

  it.effect("reports a page's subscription opened, then closed when its socket drops", () =>
    Effect.gen(function* () {
      const json = yield* roomAs("general", "ada");
      const posted = yield* json.postMessage({ text: "Before the socket drops." });
      const page = yield* following(yield* pageIn("general", "ada"), posted.id - 1);

      expect(yield* page.next(1)).toEqual([posted]);
      expect(yield* page.opened).toBe(true);

      yield* Effect.promise(() =>
        runInDurableObject(env.CHAT_ROOM.getByName("general"), (_, state) => {
          for (const socket of state.getWebSockets()) socket.close(1011, "going away");
        }),
      );

      const closed = yield* page.closed;

      expect(Exit.findErrorOption(closed).pipe(Option.getOrUndefined)).toMatchObject({
        _tag: "RpcClientError",
      });
    }).pipe(Effect.scoped, Effect.provide(worker)),
  );

  it.effect("reports a page's subscription closed with a defect it cannot decode", () =>
    Effect.gen(function* () {
      const json = yield* roomAs("design", "ada");
      const posted = yield* json.postMessage({ text: "Before the bad chunk." });
      const { socket, protocol } = yield* roomSocket("design");
      const requestIds: Array<string | number> = [];

      socket.addEventListener("message", ({ data }) => {
        Option.map(chunkOf(data), ({ requestId }) => requestIds.push(requestId));
      });

      const page = yield* following(
        yield* Effect.provideContext(openRoom("ada"), protocol),
        posted.id - 1,
      );

      expect(yield* page.next(1)).toEqual([posted]);

      // What a page receives from an object of a newer version, or a broken one: a message
      // whose fields no longer decode as the page's `Message`.
      yield* Effect.promise(() =>
        runInDurableObject(env.CHAT_ROOM.getByName("design"), (_, state) => {
          for (const open of state.getWebSockets()) {
            open.send(
              JSON.stringify({ _tag: "Chunk", requestId: requestIds[0], values: [{ id: "x" }] }),
            );
          }
        }),
      );

      const closed = yield* page.closed;

      expect(Exit.isFailure(closed) && Cause.hasDies(closed.cause)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(worker)),
  );

  it.effect("keeps a page following across an eviction: a later message still reaches it", () =>
    Effect.gen(function* () {
      const reader = yield* pageIn("design", "ada");
      const json = yield* roomAs("design", "ada");
      const first = yield* json.postMessage({ text: "Before the eviction." });
      const page = yield* following(reader, first.id - 1);

      expect(yield* page.next(1)).toEqual([first]);

      yield* Effect.promise(() => evictDurableObject(env.CHAT_ROOM.getByName("design")));

      const after = yield* json.postMessage({ text: "After the eviction." });

      expect(yield* page.next(1)).toEqual([after]);
    }).pipe(Effect.scoped, Effect.provide(worker)),
  );

  it.effect("authenticates a socket's messages by the token of its upgrade, after eviction", () =>
    Effect.gen(function* () {
      const { protocol } = yield* roomSocket("design", { authorization: "Bearer ada" });
      const client = yield* Effect.provideContext(ActionRpc.client(RoomRpc), protocol);
      const posted = yield* client.postMessage({ text: "Before the eviction." });

      yield* Effect.promise(() => evictDurableObject(env.CHAT_ROOM.getByName("design")));

      const watched = yield* client
        .watch({ after: posted.id - 1 })
        .pipe(Stream.take(1), Stream.runCollect);

      const anonymous = yield* roomAs("design").pipe(
        Effect.flatMap((json) => Effect.flip(json.postMessage({ text: "Anonymous." }))),
      );

      expect(watched).toEqual([posted]);
      expect(anonymous).toBeInstanceOf(Action.Unauthenticated);
    }).pipe(Effect.scoped, Effect.provide(worker)),
  );

  it.effect("refuses a member outside the room, on its socket and on its JSON routes", () =>
    Effect.gen(function* () {
      const page = yield* following(yield* pageIn("design", "grace"), 0);
      const json = yield* roomAs("design", "grace");
      const closed = yield* page.closed;

      expect(Exit.findErrorOption(closed).pipe(Option.getOrUndefined)).toBeInstanceOf(
        Action.Forbidden,
      );
      expect(yield* page.opened).toBe(false);
      expect(yield* Effect.flip(json.postMessage({ text: "Let me in." }))).toBeInstanceOf(
        Action.Forbidden,
      );
    }).pipe(Effect.scoped, Effect.provide(worker)),
  );

  it.effect("refuses to delete another member's message", () =>
    Effect.gen(function* () {
      const ada = yield* pageIn("general", "ada");
      const grace = yield* pageIn("general", "grace");
      const posted = yield* ada.post("Mine.");

      expect(yield* grace.remove(posted.id)).toBe("not-yours");

      const page = yield* following(grace, posted.id - 1);

      expect(yield* page.next(1)).toEqual([posted]);
    }).pipe(Effect.scoped),
  );

  it.effect("answers the lobby's previews from each room's object, without what was said", () =>
    Effect.gen(function* () {
      const design = yield* roomAs("design", "ada");
      const posted = yield* design.postMessage({ text: "Seen from the lobby." });
      const lobby = yield* ActionHttp.client(LobbyHttp, { baseUrl: "https://chat.example" });
      const { previews } = yield* lobby.previews();

      expect(previews.map(({ room }) => room)).toEqual(["general", "design"]);
      expect(previews).toContainEqual({ room: "design", latestAt: posted.at });
    }).pipe(Effect.provide(worker)),
  );

  it.effect("routes only a room's own path to its object, and other names to the lobby", () =>
    Effect.gen(function* () {
      const status = (path: string) =>
        Effect.promise(() =>
          exports.default.fetch(`https://chat.example${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
        ).pipe(Effect.map(({ status }) => status));

      expect(yield* status("/rooms/design/api/preview")).toBe(200);
      expect(yield* status("/rooms/design//elsewhere.example/api/preview")).toBe(404);
      expect(yield* status("/rooms/Not_A_Room/api/preview")).toBe(404);
      expect(yield* status("/rooms/unlisted/api/preview")).toBe(404);
    }),
  );

  it.effect("expires a message a day old when the room's alarm runs, and sets the next", () =>
    Effect.gen(function* () {
      const design = yield* roomAs("design", "ada");
      const stub = env.CHAT_ROOM.getByName("design");

      yield* Effect.promise(() =>
        runInDurableObject(stub, (_, state) => {
          state.storage.sql.exec("DELETE FROM messages");
        }),
      );

      const old = yield* design.postMessage({ text: "From yesterday." });
      const recent = yield* design.postMessage({ text: "From today." });

      yield* Effect.promise(() =>
        runInDurableObject(stub, (_, state) => {
          state.storage.sql.exec("UPDATE messages SET at = at - ? WHERE id = ?", day, old.id);
        }),
      );

      expect(yield* Effect.promise(() => runDurableObjectAlarm(stub))).toBe(true);

      const page = yield* following(yield* pageIn("design", "ada"), 0);
      const kept = yield* page.next(1);

      const next = yield* Effect.promise(() =>
        runInDurableObject(stub, (_, state) => state.storage.getAlarm()),
      );

      expect(kept).toEqual([recent]);
      expect(next).toBe(recent.at + day);
    }).pipe(Effect.scoped, Effect.provide(worker)),
  );
});
