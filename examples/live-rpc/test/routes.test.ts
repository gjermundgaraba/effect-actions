import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as ActionRpc from "@gjermundgaraba/effect-actions/ActionRpc";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { roomHeader } from "../src/chat/Chat.js";
import { MessageStore } from "../src/chat/store.js";
import { rpc } from "../src/routes.js";
import { Rpc } from "../src/Rpc.js";

// What the wire adds: the real rpcs, behind their real authentication and middleware,
// answering in memory. The test gives them Effect's HTTP protocol, not the server's WebSocket,
// because `Testing.layer` answers HTTP requests; no port is opened.
const server = rpc.pipe(
  Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
  Layer.provide(RpcSerialization.layerJson),
);

const served = RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
  Layer.provide(RpcSerialization.layerJson),
  Layer.provide(Testing.layer(server)),
  Layer.provide(MessageStore.layerMemory),
);

// Each call carries its caller's token, so one client serves every caller of a test.
const as = (token: string) => RpcClient.withHeaders({ authorization: `Bearer ${token}` });

const inRoom = (room: string) => RpcClient.withHeaders({ [roomHeader]: room });

describe("the chat, over RPC", () => {
  it.effect(
    "answers the public rpc without a token and refuses a protected rpc without a known token",
    () =>
      Effect.gen(function* () {
        const client = yield* ActionRpc.client(Rpc);
        const signedOut = yield* Effect.flip(client.readMessages({ after: 0 }));
        const stranger = yield* Effect.flip(client.readMessages({ after: 0 }).pipe(as("mallory")));

        expect(yield* client.listRooms()).toEqual({ rooms: [] });
        expect(signedOut).toBeInstanceOf(Action.Unauthenticated);
        expect(signedOut.message).toBe("A bearer token is required.");
        expect(stranger).toBeInstanceOf(Action.Unauthenticated);
        expect(stranger.message).toBe("Unknown demo token.");
      }).pipe(Effect.provide(served)),
  );

  it.effect("authenticates each call by its own token: two callers on one client", () =>
    Effect.gen(function* () {
      const client = yield* ActionRpc.client(Rpc);

      yield* client.postMessage({ text: "Deploying at noon." }).pipe(as("ada"));
      yield* client.postMessage({ text: "Ready." }).pipe(as("grace"));

      expect(yield* client.readMessages({ after: 0 }).pipe(as("grace"))).toEqual({
        messages: [
          { id: 1, author: "ada", text: "Deploying at noon." },
          { id: 2, author: "grace", text: "Ready." },
        ],
      });
    }).pipe(Effect.provide(served)),
  );

  it.effect("gives each call the room its header names, and the lobby when it names none", () =>
    Effect.gen(function* () {
      const client = yield* ActionRpc.client(Rpc);

      yield* client.postMessage({ text: "Disk is full." }).pipe(as("ada"), inRoom("ops"));
      yield* client.postMessage({ text: "Hello." }).pipe(as("ada"));

      expect(yield* client.readMessages({ after: 0 }).pipe(as("ada"), inRoom("ops"))).toEqual({
        messages: [{ id: 1, author: "ada", text: "Disk is full." }],
      });
      expect(yield* client.readMessages({ after: 0 }).pipe(as("ada"), inRoom("lobby"))).toEqual({
        messages: [{ id: 1, author: "ada", text: "Hello." }],
      });
    }).pipe(Effect.provide(served)),
  );

  it.effect("refuses a member a room they have not joined, naming it", () =>
    Effect.gen(function* () {
      const client = yield* ActionRpc.client(Rpc);
      const read = client.readMessages({ after: 0 }).pipe(as("grace"), inRoom("ops"));
      const refused = yield* Effect.flip(read);

      expect(refused).toBeInstanceOf(Action.Forbidden);
      expect(refused.message).toBe("Not a member of ops.");
    }).pipe(Effect.provide(served)),
  );

  it.effect("serves a native RpcGroup: Effect's own client calls the same rpcs", () =>
    Effect.gen(function* () {
      // `Rpc.group` is what Effect's RPC tooling takes. Its methods take the payload as sent,
      // `{}` included; `ActionRpc.client` is the one to write an application with.
      const native = yield* RpcClient.make(Rpc.group);

      expect(yield* native.listRooms({})).toEqual({ rooms: [] });
    }).pipe(Effect.provide(served)),
  );
});
