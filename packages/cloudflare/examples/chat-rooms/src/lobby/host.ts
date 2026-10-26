import { Context, type Effect } from "effect";
import type { RoomPreview } from "./Lobby.js";

/** The lobby's object as the Worker reaches it. */
export class LobbyHost extends Context.Service<
  LobbyHost,
  { readonly previews: Effect.Effect<ReadonlyArray<RoomPreview>> }
>()("chat-rooms/LobbyHost") {}
