import * as ActionDurableObject from "@gjermundgaraba/effect-actions-cloudflare/ActionDurableObject";
import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";

import { Activity } from "../chat/activity.js";
import { Room } from "../chat/room.js";
import { MessageStore } from "../chat/store.js";
import { LobbyCalls } from "../lobby/Calls.js";
import { LobbyHost } from "../lobby/host.js";

const lobbyStub = () => env.CHAT_LOBBY.getByName("lobby");

export const layerLobbyHost = Layer.effect(LobbyHost)(
  Effect.map(ActionDurableObject.client(LobbyCalls), (lobby) =>
    LobbyHost.of({ previews: Effect.orDie(lobby(lobbyStub).previews()) })
  )
);

export const tellLobby = Effect.gen(function* () {
  const room = yield* Room;
  const latest = yield* MessageStore.use((store) => store.latest);
  const lobby = yield* ActionDurableObject.client(LobbyCalls);

  yield* lobby(lobbyStub).roomChanged({ room, latestAt: latest?.at ?? null });
});

export const layerActivity = Layer.effect(Activity)(
  Effect.map(ActionDurableObject.Tasks, (tasks) =>
    Activity.of({ changing: (change) => tasks.runAfter("lobby", change) })
  )
);
