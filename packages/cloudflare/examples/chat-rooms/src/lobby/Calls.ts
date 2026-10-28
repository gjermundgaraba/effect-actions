import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import { RoomPreview } from "./Lobby.js";

export const LobbyCalls = RpcGroup.make(
  Rpc.make("roomChanged", { payload: RoomPreview }),
  Rpc.make("previews", { success: Schema.Array(RoomPreview) })
);
