import { Context, type Effect } from "effect";
import type { RoomName } from "../chat/Chat.js";

/** The rooms as the Worker reaches them: each its own Durable Object. */
export class Rooms extends Context.Service<
  Rooms,
  { readonly latestAt: (room: RoomName) => Effect.Effect<number | null> }
>()("chat-rooms/Rooms") {}
