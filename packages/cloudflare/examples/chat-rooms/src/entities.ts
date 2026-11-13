import * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";

import { RoomTells } from "./chat/Tells.js";
import { RoomChanges } from "./lobby/Changes.js";
import { LobbyRpc, RoomRpc } from "./Rpc.js";

const byRoom = (input: { readonly room: string }) => input.room;

export const Room = ActionEntity.make("Room", RoomRpc, {
  key: {
    readMessages: byRoom,
    postMessage: byRoom,
    deleteMessage: byRoom,
    "message.posted": byRoom,
  },
  rpcs: RoomTells,
});

const theLobby = () => "lobby";

export const Lobby = ActionEntity.make("Lobby", LobbyRpc, {
  key: { previews: theLobby, "previews.changed": theLobby },
  rpcs: RoomChanges,
});
