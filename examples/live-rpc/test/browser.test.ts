import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { chatOver, openChat } from "../src/browser.js";
import { MessageStore } from "../src/chat/store.js";
import { rpc } from "../src/routes.js";

// The page's client against the real rpcs, in memory, served as in routes.test.ts. `openChat`
// needs a client protocol and does not care which: a page gives it `connection(url)`, a
// WebSocket, and this test Effect's HTTP protocol.
const served = RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
  Layer.provide(RpcSerialization.layerJson),
  Layer.provide(
    Testing.layer(
      rpc.pipe(
        Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
        Layer.provide(RpcSerialization.layerJson),
      ),
    ),
  ),
  Layer.provide(MessageStore.layerMemory),
);

describe("the page's client", () => {
  it.effect("posts and reads in the room it names, as the member its token names", () =>
    Effect.gen(function* () {
      const chat = yield* openChat;
      const first = yield* chat.room("lobby", "ada").post("Deploying at noon.");
      const second = yield* chat.room("lobby", "grace").post("Ready.");

      yield* chat.room("ops", "ada").post("Disk is full.");

      expect(first).toEqual({ id: 1, author: "ada", text: "Deploying at noon." });
      expect(yield* chat.room("lobby", "grace").read(first.id)).toEqual({
        access: "member",
        messages: [second],
      });
      expect(yield* chat.rooms).toEqual([
        { name: "lobby", messages: 2 },
        { name: "ops", messages: 1 },
      ]);
    }).pipe(Effect.provide(served)),
  );

  it.effect("turns each declared error of a removal into what the page shows", () =>
    Effect.gen(function* () {
      const chat = yield* openChat;
      const ada = chat.room("lobby", "ada");
      const grace = chat.room("lobby", "grace");
      const { id } = yield* ada.post("Oops.");

      expect(yield* grace.remove(id)).toBe("not-yours");
      expect(yield* grace.read(0)).toMatchObject({ messages: [{ id }] });
      expect(yield* ada.remove(id)).toBe("removed");
      expect(yield* grace.read(0)).toEqual({ access: "member", messages: [] });
      expect(yield* ada.remove(id)).toBe("removed");
    }).pipe(Effect.provide(served)),
  );

  it.effect("turns each refusal of a read into the access the page shows", () =>
    Effect.gen(function* () {
      const chat = yield* openChat;

      yield* chat.room("ops", "ada").post("Disk is full.");

      expect(yield* chat.room("ops", "grace").read(0)).toEqual({
        access: "not-a-member",
        messages: [],
      });
      expect(yield* chat.room("ops", "expired").read(0)).toEqual({
        access: "signed-out",
        messages: [],
      });
    }).pipe(Effect.provide(served)),
  );

  // `connect(url)` is this with a WebSocket. Each test's runtime builds its own layer, and so
  // its own store.
  it("answers a page that is not an Effect program with promises, until it closes", async () => {
    const chat = chatOver(served);

    const posted = await chat.room("lobby", "ada").post("Deploying at noon.");

    expect(posted).toEqual({ id: 1, author: "ada", text: "Deploying at noon." });
    expect(await chat.room("lobby", "grace").read(0)).toEqual({
      access: "member",
      messages: [posted],
    });
    expect(await chat.room("lobby", "grace").remove(posted.id)).toBe("not-yours");
    expect(await chat.room("ops", "expired").read(0)).toEqual({
      access: "signed-out",
      messages: [],
    });
    expect(await chat.rooms()).toEqual([{ name: "lobby", messages: 1 }]);

    // A failure `openChat` does not handle rejects: here, a text the contract refuses.
    await expect(chat.room("lobby", "ada").post("")).rejects.toBeInstanceOf(Action.InvalidInput);

    await chat.close();

    await expect(chat.rooms()).rejects.toThrow();
  });
});
