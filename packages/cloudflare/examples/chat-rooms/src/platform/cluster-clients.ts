import { Effect, Layer } from "effect";
import { Entity } from "effect/cluster";

import { RoomMailbox } from "../chat/mailbox.js";
import { Expire } from "../chat/Tells.js";
import { Lobby, Room } from "../entities.js";
import { LobbyClient } from "../lobby/client.js";

export const layerRoomMailbox = Layer.effect(RoomMailbox)(
  Effect.gen(function* () {
    const { entityId } = yield* Entity.CurrentAddress;
    const rooms = yield* Room.client;
    const room = rooms(entityId);

    return RoomMailbox.of({
      expire: (at) =>
        Effect.orDie(room.expire(new Expire({ at }), { discard: true })),
      tellLobby: Effect.orDie(room.tellLobby(undefined, { discard: true })),
    });
  })
);

export const layerLobbyClient = Layer.effect(LobbyClient)(
  Effect.gen(function* () {
    const lobbies = yield* Lobby.client;
    const lobby = lobbies("lobby");

    return LobbyClient.of({
      roomChanged: (change) => Effect.orDie(lobby.roomChanged(change)),
    });
  })
);
