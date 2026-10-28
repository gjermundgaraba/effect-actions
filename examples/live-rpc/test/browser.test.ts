import { describe, expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import * as Event from "@gjermundgaraba/effect-actions/Event";
import * as Testing from "@gjermundgaraba/effect-actions/Testing";
import { Effect, Fiber, Layer, Stream } from "effect";
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc";
import { TestClock } from "effect/testing";

import { openChat } from "../src/browser.js";
import { MessageStore } from "../src/chat/store.js";
import { chatOver } from "../src/page.js";
import { rpc } from "../src/routes.js";

const served = RpcClient.layerProtocolHttp({ url: "/rpc" }).pipe(
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provide(
    Testing.layer(
      rpc.pipe(
        Layer.provide(RpcServer.layerProtocolHttp({ path: "/rpc" })),
        Layer.provide(RpcSerialization.layerNdjson)
      )
    )
  ),
  Layer.provide([MessageStore.layerMemory, Event.layerMemory])
);

describe("the page's client", () => {
  it.effect(
    "posts and reads in the room it names, as the member its token names",
    () =>
      Effect.gen(function* () {
        const chat = yield* openChat;

        const first = yield* chat
          .room("lobby", "ada")
          .post("Deploying at noon.");

        const second = yield* chat.room("lobby", "grace").post("Ready.");

        yield* chat.room("ops", "ada").post("Disk is full.");

        expect(first).toStrictEqual({
          id: 1,
          author: "ada",
          text: "Deploying at noon.",
        });
        expect(yield* chat.room("lobby", "grace").read(first.id)).toStrictEqual(
          {
            access: "member",
            messages: [second],
          }
        );
        expect(yield* chat.rooms).toStrictEqual([
          { name: "lobby", messages: 2 },
          { name: "ops", messages: 1 },
        ]);
      }).pipe(Effect.provide(served))
  );

  it.effect(
    "turns each declared error of a removal into what the page shows",
    () =>
      Effect.gen(function* () {
        const chat = yield* openChat;
        const ada = chat.room("lobby", "ada");
        const grace = chat.room("lobby", "grace");
        const { id } = yield* ada.post("Oops.");

        expect(yield* grace.remove(id)).toBe("not-yours");
        expect(yield* grace.read(0)).toMatchObject({ messages: [{ id }] });
        expect(yield* ada.remove(id)).toBe("removed");
        expect(yield* grace.read(0)).toStrictEqual({
          access: "member",
          messages: [],
        });
        expect(yield* ada.remove(id)).toBe("removed");
      }).pipe(Effect.provide(served))
  );

  it.effect("turns each refusal of a read into the access the page shows", () =>
    Effect.gen(function* () {
      const chat = yield* openChat;

      yield* chat.room("ops", "ada").post("Disk is full.");

      expect(yield* chat.room("ops", "grace").read(0)).toStrictEqual({
        access: "not-a-member",
        messages: [],
      });
      expect(yield* chat.room("ops", "expired").read(0)).toStrictEqual({
        access: "signed-out",
        messages: [],
      });
    }).pipe(Effect.provide(served))
  );

  it.effect(
    "streams the posts after what the page read, one posted in between included",
    () =>
      Effect.gen(function* () {
        const chat = yield* openChat;
        const lobby = chat.room("lobby", "grace");

        yield* chat.room("lobby", "ada").post("Deploying at noon.");

        const { messages } = yield* lobby.read(0);

        yield* chat.room("lobby", "ada").post("Done.");

        const watched = yield* lobby
          .messages(messages.at(-1)?.id ?? 0)
          .pipe(Stream.take(1), Stream.runCollect);

        expect(watched).toMatchObject([
          { _tag: "Occurrence", data: { id: 2, text: "Done." } },
        ]);
      }).pipe(Effect.provide(served))
  );

  it.effect(
    "sends a gap first for an id the room never gave, then the posts after its last",
    () =>
      Effect.gen(function* () {
        const chat = yield* openChat;

        const watching = yield* chat
          .room("lobby", "grace")
          .messages(7)
          .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);

        yield* Effect.repeat(TestClock.adjust("0 millis"), { times: 10 });
        yield* chat.room("lobby", "ada").post("Hello again.");

        expect(yield* Fiber.join(watching)).toMatchObject([
          { _tag: "Gap" },
          { _tag: "Occurrence", data: { id: 1, text: "Hello again." } },
        ]);
      }).pipe(Effect.provide(served))
  );

  it("answers a page that is not an Effect program with promises, until it closes", async () => {
    const chat = chatOver(served);

    const posted = await chat.room("lobby", "ada").post("Deploying at noon.");

    expect(posted).toStrictEqual({
      id: 1,
      author: "ada",
      text: "Deploying at noon.",
    });
    await expect(chat.room("lobby", "grace").read(0)).resolves.toStrictEqual({
      access: "member",
      messages: [posted],
    });
    await expect(chat.room("lobby", "grace").remove(posted.id)).resolves.toBe(
      "not-yours"
    );
    await expect(chat.room("ops", "expired").read(0)).resolves.toStrictEqual({
      access: "signed-out",
      messages: [],
    });
    await expect(chat.rooms()).resolves.toStrictEqual([
      { name: "lobby", messages: 1 },
    ]);

    await expect(chat.room("lobby", "ada").post("")).rejects.toBeInstanceOf(
      Action.InvalidInput
    );

    await chat.close();

    await expect(chat.rooms()).rejects.toThrow("disposed");
  });
});
