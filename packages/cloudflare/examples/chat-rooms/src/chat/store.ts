import { Context } from "effect";
import type { Effect } from "effect";

import type { Message, MessageNotFound, NotAuthor } from "./Chat.js";

export class MessageStore extends Context.Service<
  MessageStore,
  {
    readonly latest: Effect.Effect<{
      readonly at: number | null;
      readonly version: number;
    }>;
    readonly oldest: Effect.Effect<Message | null>;
    readonly last: Effect.Effect<number>;
    readonly read: (after: number) => Effect.Effect<readonly Message[]>;
    readonly post: (
      author: string,
      text: string,
      at: number
    ) => Effect.Effect<Message>;
    readonly remove: (
      author: string,
      id: number
    ) => Effect.Effect<void, MessageNotFound | NotAuthor>;
    readonly expire: (before: number) => Effect.Effect<void>;
  }
>()("chat-rooms/MessageStore") {}
