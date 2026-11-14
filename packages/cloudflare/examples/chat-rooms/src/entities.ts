import * as ActionEntity from "@gjermundgaraba/effect-actions/ActionEntity";

import { RoomRpc } from "./Rpc.js";

export const Room = ActionEntity.make("Room", RoomRpc, {
  key: ({ room }) => room,
});
