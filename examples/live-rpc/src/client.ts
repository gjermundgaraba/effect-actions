import { NodeRuntime, NodeSocket } from "@effect/platform-node";
import { Config, Console, Effect, Layer, Stream } from "effect";

import { connection, openChat } from "./browser.js";

const visit = Effect.gen(function* () {
  const chat = yield* openChat;

  const ada = chat.room("lobby", "ada");
  const grace = chat.room("lobby", "grace");

  yield* Console.log("rooms, before signing in:", yield* chat.rooms);

  const posted = yield* ada.post("Deploying at noon.");

  yield* Console.log("ada posts:", posted);
  yield* Console.log("grace reads:", yield* grace.read(posted.id - 1));
  yield* Console.log(
    "grace watches:",
    yield* grace.messages(posted.id - 1).pipe(Stream.take(1), Stream.runCollect)
  );
  yield* Console.log("grace removes it:", yield* grace.remove(posted.id));
  yield* Console.log("ada removes it:", yield* ada.remove(posted.id));
  yield* Console.log(
    "grace reads ops:",
    yield* chat.room("ops", "grace").read(0)
  );
  yield* Console.log(
    "an expired token reads:",
    yield* chat.room("lobby", "expired").read(0)
  );
});

const main = Effect.gen(function* () {
  const url = yield* Config.String("CHAT_URL").pipe(
    Config.withDefault("ws://127.0.0.1:3000/rpc")
  );

  yield* visit.pipe(
    Effect.scoped,
    Effect.provide(
      connection(url).pipe(Layer.provide(NodeSocket.layerWebSocketConstructor))
    )
  );
});

NodeRuntime.runMain(main);
