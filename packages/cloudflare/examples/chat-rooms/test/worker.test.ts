import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Queue, Stream } from "effect";
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
  Effect.flatMap(roomSocket(room, headers), (protocol) =>
    Effect.provideContext(openRoom(token), protocol),
  );

// What a page following the room renders, after `after`: `next(n)` waits for the next `n`.
const following = (page: Effect.Success<ReturnType<typeof openRoom>>, after: number) =>
  Effect.gen(function* () {
    const rendered = yield* Queue.unbounded<Message>();

    yield* Effect.forkScoped(page.follow(after, (message) => Queue.offer(rendered, message)));

    return { next: (count: number) => Queue.takeN(rendered, count) };
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
      const protocol = yield* roomSocket("design", { authorization: "Bearer ada" });
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
      const page = yield* pageIn("design", "grace");
      const json = yield* roomAs("design", "grace");

      expect(yield* Effect.flip(page.follow(0, () => Effect.void))).toBeInstanceOf(
        Action.Forbidden,
      );
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
