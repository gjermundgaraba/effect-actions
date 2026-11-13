import { Context } from "effect";
import type { Effect } from "effect";

import type { Task } from "./Tells.js";

export class RoomMailbox extends Context.Service<
  RoomMailbox,
  {
    readonly expire: (at: number) => Effect.Effect<void>;
    readonly tellLobby: Effect.Effect<void>;
    readonly retry: (
      task: Task,
      at: number,
      attempt: number
    ) => Effect.Effect<void>;
  }
>()("chat-rooms/RoomMailbox") {}
