import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { RoomName } from "../chat/Chat.js";
import { RoomPreview } from "./Lobby.js";

// The lobby's own API, over its stub, as a room's is: a room says it changed, and the Worker
// reads the previews. A room sends no value, only its name: the lobby reads the room's latest
// activity from the room itself, so a change it hears of late never overwrites a later one.
export const LobbyCalls = RpcGroup.make(
  Rpc.make("roomChanged", { payload: { room: RoomName } }),
  Rpc.make("previews", { success: Schema.Array(RoomPreview) }),
);
