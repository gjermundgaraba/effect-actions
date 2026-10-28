import { Context } from "effect";
import type { Effect } from "effect";

import type { Message, MessageNotFound, NotAuthor } from "./Chat.js";

export class MessageStore extends Context.Service<
  MessageStore,
  {
    readonly latest: Effect.Effect<Message | null>;
    readonly last: Effect.Effect<number>;
    readonly read: (after: number) => Effect.Effect<readonly Message[]>;
    readonly post: (author: string, text: string) => Effect.Effect<Message>;
    readonly remove: (
      author: string,
      id: number
    ) => Effect.Effect<void, MessageNotFound | NotAuthor>;
    readonly expire: Effect.Effect<void>;
  }
>()("chat-rooms/MessageStore") {}
