import { Context } from "effect";
import type { Effect } from "effect";

import type { RoomChange } from "./Changes.js";
import type { RoomPreview } from "./Lobby.js";

export class PreviewStore extends Context.Service<
  PreviewStore,
  {
    readonly read: Effect.Effect<readonly RoomPreview[]>;
    readonly record: (
      change: RoomChange,
      announce: Effect.Effect<void>
    ) => Effect.Effect<void>;
  }
>()("chat-rooms/PreviewStore") {}
