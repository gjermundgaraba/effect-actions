import { Context } from "effect";
import type { Effect } from "effect";

import type { DemoRoomName } from "../chat/Chat.js";
import type { RoomPreview } from "./Lobby.js";

export class PreviewStore extends Context.Service<
  PreviewStore,
  {
    readonly read: Effect.Effect<readonly RoomPreview[]>;
    readonly record: (
      room: DemoRoomName,
      latestAt: number | null
    ) => Effect.Effect<boolean>;
  }
>()("chat-rooms/PreviewStore") {}
