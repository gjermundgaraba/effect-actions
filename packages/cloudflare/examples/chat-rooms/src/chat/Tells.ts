import { DateTime, PrimaryKey, Schema } from "effect";
import { ClusterSchema, DeliverAt } from "effect/cluster";
import { Rpc, RpcGroup } from "effect/rpc";

const hour = 60 * 60 * 1000;

export const day = 24 * hour;

export const windowOf = (postedAt: number) =>
  Math.ceil((postedAt + day) / hour) * hour;

export class Expire extends Schema.Class<
  Expire,
  { readonly brand: unique symbol }
>("chat-rooms/Expire")({ at: Schema.Int }) {
  [PrimaryKey.symbol]() {
    return String(this.at);
  }

  [DeliverAt.symbol]() {
    return DateTime.makeUnsafe(this.at);
  }
}

export const RoomTells = RpcGroup.make(
  Rpc.make("expire", { payload: Expire }),
  Rpc.make("tellLobby")
).annotateRpcs(ClusterSchema.Persisted, true);
