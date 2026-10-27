import { describe, expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Effect, Fiber, Layer, Stream } from "effect";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";
import { TestClock } from "effect/testing";

import { MessagePosted, roomHeader } from "../src/chat/Chat.js";
import { MessageStore } from "../src/chat/store.js";
import { rpc } from "../src/routes.js";
import { Rpc } from "../src/Rpc.js";

// What the wire adds: the real rpcs, behind their real authentication and middleware,
// answering in memory. The test gives them Effect's HTTP protocol, not the server's WebSocket,
// because `Testing.layer` answers HTTP requests; no port is opened. NDJSON, not JSON: over
// HTTP, JSON sends a response once all its streams end, so a watch would never answer.
const server = rpc.pipe(
  Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerNdjson)
);

const served = RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provide(Testing.layer(server)),
  Layer.provide([MessageStore.layerMemory, Event.layerMemory])
);

// Each call carries its caller's token, so one client serves every caller of a test.
const as = (token: string) =>
  RpcClient.withHeaders({ authorization: `Bearer ${token}` });

const inRoom = (room: string) => RpcClient.withHeaders({ [roomHeader]: room });

describe("the chat, over RPC", () => {
  it.effect(
    "answers the public rpc without a token and refuses a protected rpc without a known token",
    () =>
      Effect.gen(function* () {
        const client = yield* ActionRpc.client(Rpc);
        const signedOut = yield* Effect.flip(client.readMessages({ after: 0 }));

        const stranger = yield* Effect.flip(
          client.readMessages({ after: 0 }).pipe(as("mallory"))
        );

        expect(yield* client.listRooms()).toStrictEqual({ rooms: [] });
        expect(signedOut).toBeInstanceOf(Action.Unauthenticated);
        expect(signedOut.message).toBe("A bearer token is required.");
        expect(stranger).toBeInstanceOf(Action.Unauthenticated);
        expect(stranger.message).toBe("Unknown demo token.");
      }).pipe(Effect.provide(served))
  );

  it.effect(
    "authenticates each call by its own token: two callers on one client",
    () =>
      Effect.gen(function* () {
        const client = yield* ActionRpc.client(Rpc);

        yield* client
          .postMessage({ text: "Deploying at noon." })
          .pipe(as("ada"));
        yield* client.postMessage({ text: "Ready." }).pipe(as("grace"));

        expect(
          yield* client.readMessages({ after: 0 }).pipe(as("grace"))
        ).toStrictEqual({
          messages: [
            { id: 1, author: "ada", text: "Deploying at noon." },
            { id: 2, author: "grace", text: "Ready." },
          ],
        });
      }).pipe(Effect.provide(served))
  );

  it.effect(
    "gives each call the room its header names, and the lobby when it names none",
    () =>
      Effect.gen(function* () {
        const client = yield* ActionRpc.client(Rpc);

        yield* client
          .postMessage({ text: "Disk is full." })
          .pipe(as("ada"), inRoom("ops"));
        yield* client.postMessage({ text: "Hello." }).pipe(as("ada"));

        expect(
          yield* client
            .readMessages({ after: 0 })
            .pipe(as("ada"), inRoom("ops"))
        ).toStrictEqual({
          messages: [{ id: 1, author: "ada", text: "Disk is full." }],
        });
        expect(
          yield* client
            .readMessages({ after: 0 })
            .pipe(as("ada"), inRoom("lobby"))
        ).toStrictEqual({
          messages: [{ id: 1, author: "ada", text: "Hello." }],
        });
      }).pipe(Effect.provide(served))
  );

  it.effect("refuses a member a room they have not joined, naming it", () =>
    Effect.gen(function* () {
      const client = yield* ActionRpc.client(Rpc);

      const read = client
        .readMessages({ after: 0 })
        .pipe(as("grace"), inRoom("ops"));

      const refused = yield* Effect.flip(read);

      expect(refused).toBeInstanceOf(Action.Forbidden);
      expect(refused.message).toBe("Not a member of ops.");
    }).pipe(Effect.provide(served))
  );

  it.effect(
    "streams a room's posts to a member watching it, the room named by its header",
    () =>
      Effect.gen(function* () {
        const client = yield* ActionRpc.client(Rpc);

        const watching = yield* client
          .watch(MessagePosted, {})
          .pipe(
            Stream.take(1),
            Stream.runCollect,
            as("grace"),
            inRoom("lobby"),
            Effect.forkChild
          );

        // Let the watch take its position through the in-memory socket before anyone posts.
        yield* Effect.repeat(TestClock.adjust("0 millis"), { times: 10 });
        yield* client
          .postMessage({ text: "Disk is full." })
          .pipe(as("ada"), inRoom("ops"));
        yield* client
          .postMessage({ text: "Ready." })
          .pipe(as("ada"), inRoom("lobby"));

        expect(yield* Fiber.join(watching)).toMatchObject([
          {
            _tag: "Occurrence",
            data: { id: 1, author: "ada", text: "Ready." },
          },
        ]);
      }).pipe(Effect.provide(served))
  );

  it.effect(
    "refuses a watch of a room the member has not joined, as it starts",
    () =>
      Effect.gen(function* () {
        const client = yield* ActionRpc.client(Rpc);

        const refused = yield* Effect.flip(
          Stream.runDrain(client.watch(MessagePosted, {})).pipe(
            as("grace"),
            inRoom("ops")
          )
        );

        expect(refused).toBeInstanceOf(Action.Forbidden);
        expect(refused).toMatchObject({ message: "Not a member of ops." });
      }).pipe(Effect.provide(served))
  );

  it.effect(
    "serves a native RpcGroup: Effect's own client calls the same rpcs",
    () =>
      Effect.gen(function* () {
        // `Rpc.group` is what Effect's RPC tooling takes. Its methods take the payload as sent,
        // `{}` included; `ActionRpc.client` is the one to write an application with.
        const native = yield* RpcClient.make(Rpc.group);

        expect(yield* native.listRooms({})).toStrictEqual({ rooms: [] });
      }).pipe(Effect.provide(served))
  );
});
