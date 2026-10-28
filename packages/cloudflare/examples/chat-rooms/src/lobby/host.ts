import { Context } from "effect";
import type { Effect } from "effect";

import type { RoomPreview } from "./Lobby.js";

export class LobbyHost extends Context.Service<
  LobbyHost,
  { readonly previews: Effect.Effect<readonly RoomPreview[]> }
>()("chat-rooms/LobbyHost") {}
