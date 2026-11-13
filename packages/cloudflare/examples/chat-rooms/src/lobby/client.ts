import { Context } from "effect";
import type { Effect } from "effect";

import type { RoomChange } from "./Changes.js";

export class LobbyClient extends Context.Service<
  LobbyClient,
  {
    readonly roomChanged: (change: RoomChange) => Effect.Effect<void>;
  }
>()("chat-rooms/LobbyClient") {}
