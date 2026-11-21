import { Context } from "effect";
import type { Effect } from "effect";

import type { Message } from "./Chat.js";

export class MessageStore extends Context.Service<
  MessageStore,
  {
    readonly last: Effect.Effect<number>;
    readonly read: (after: number) => Effect.Effect<readonly Message[]>;
    /** Writes `message` and runs `announce` in one transaction, or returns the message its author already posted with that `request` without announcing it again. */
    readonly post: (
      message: Omit<Message, "id"> & { readonly request: string | undefined },
      announce: Effect.Effect<void>
    ) => Effect.Effect<Message>;
  }
>()("chat-rooms/MessageStore") {}
