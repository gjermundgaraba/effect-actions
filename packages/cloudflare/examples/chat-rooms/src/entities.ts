import * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";

import { RoomRpc } from "./Rpc.js";

const byRoom = (input: { readonly room: string }) => input.room;

export const Room = ActionEntity.make("Room", RoomRpc, {
  key: {
    readMessages: byRoom,
    postMessage: byRoom,
    "message.posted": byRoom,
  },
});
