import { Context } from "effect";
import type { Effect } from "effect";

import type { Message } from "./Chat.js";

export class MessageStore extends Context.Service<
  MessageStore,
  {
    readonly last: Effect.Effect<number>;
    readonly read: (after: number) => Effect.Effect<readonly Message[]>;
    readonly post: (
      author: string,
      text: string,
      at: number,
      announce: Effect.Effect<void>
    ) => Effect.Effect<Message>;
  }
>()("chat-rooms/MessageStore") {}
