import { Context } from "effect";
import type { Effect } from "effect";

export class RoomMailbox extends Context.Service<
  RoomMailbox,
  {
    readonly expire: (at: number) => Effect.Effect<void>;
    readonly tellLobby: Effect.Effect<void>;
  }
>()("chat-rooms/RoomMailbox") {}
