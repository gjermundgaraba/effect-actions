import { Schema } from "effect";
import { ClusterSchema } from "effect/cluster";
import { Rpc, RpcGroup } from "effect/rpc";

import { RoomPreview } from "./Lobby.js";

export const RoomChange = Schema.Struct({
  preview: RoomPreview,
  version: Schema.Int,
});

export type RoomChange = typeof RoomChange.Type;

export const RoomChanges = RpcGroup.make(
  Rpc.make("roomChanged", { payload: RoomChange })
).annotateRpcs(ClusterSchema.Uninterruptible, "server");
