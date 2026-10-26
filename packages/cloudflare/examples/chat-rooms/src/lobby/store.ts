import { Context, type Effect } from "effect";
import type { RoomName } from "../chat/Chat.js";
import type { RoomPreview } from "./Lobby.js";

/** Every room's preview, as the room last told the lobby. */
export class PreviewStore extends Context.Service<
  PreviewStore,
  {
    readonly read: Effect.Effect<ReadonlyArray<RoomPreview>>;
    /** Keeps `room`'s latest activity, succeeding with whether it changed. */
    readonly record: (room: RoomName, latestAt: number | null) => Effect.Effect<boolean>;
  }
>()("chat-rooms/PreviewStore") {}
