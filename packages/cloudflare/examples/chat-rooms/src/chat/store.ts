import { Context } from "effect";
import type { Effect } from "effect";

import type { Message, MessageNotFound, NotAuthor } from "./Chat.js";

/**
 * The room's messages. That only its author deletes a message is checked here, in the data
 * access, so no surface and no handler can skip it. A message expires a day after it was
 * posted: `expire` deletes those, and the store sees that it runs.
 */
export class MessageStore extends Context.Service<
  MessageStore,
  {
    readonly latest: Effect.Effect<Message | null>;
    /** The id of the last message ever posted, kept or not, or 0 before the first. */
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
