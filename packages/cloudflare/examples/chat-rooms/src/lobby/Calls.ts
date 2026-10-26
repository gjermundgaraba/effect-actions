import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { RoomPreview } from "./Lobby.js";

// The lobby's own API, over its stub: a room tells it its latest activity, and the Worker reads
// the previews. A plain Effect `RpcGroup`, not actions: no page calls it, so it needs no contract
// checks, no authentication and no JSON route, and nothing authenticates a stub call anyway, as
// only a binding reaches it. Why a report heard late never overwrites a later one is at
// `tellLobby`, in lobby-stubs.ts, which sends it.
export const LobbyCalls = RpcGroup.make(
  Rpc.make("roomChanged", { payload: RoomPreview }),
  Rpc.make("previews", { success: Schema.Array(RoomPreview) }),
);
