import { Context, Effect, Layer, Semaphore } from "effect";
import { Chat } from "effect/ai";
import type { Member } from "../identity/Identity.js";
import { ConversationNotFound } from "./Assistant.js";

/** One member's conversation with the assistant. */
export interface Conversation {
  readonly id: string;
  /** Effect's `Chat`: the history a model reads, in which an approval's answer finds its request. */
  readonly chat: Chat.Chat;
  /** One turn at a time: a second request waits, then reads the history the first one wrote. */
  readonly turn: Semaphore.Semaphore;
}

/**
 * Where conversations are kept between requests, each with the member it belongs to. Every
 * method but `open` takes the member, so only its owner reaches a conversation: an approval is
 * acted on as the turn's caller, and must come from the member who was asked.
 */
export class Conversations extends Context.Service<
  Conversations,
  {
    readonly open: (owner: Member) => Effect.Effect<Conversation>;
    readonly find: (owner: Member, id: string) => Effect.Effect<Conversation, ConversationNotFound>;
    readonly end: (owner: Member, id: string) => Effect.Effect<void>;
  }
>()("tracker/Conversations") {
  // DEMO ONLY: memory, lost when the process stops and never trimmed. A real store keeps each
  // history where every instance reads it, `chat.exportJson` to save and `Chat.fromJson` to load.
  static readonly layerMemory = Layer.sync(Conversations, () => {
    const kept = new Map<string, Conversation>();

    // A member is a person in a workspace, and an id is unguessable: both are in the key.
    const key = (owner: Member, id: string) => `${owner.workspace}/${owner.id}/${id}`;

    return Conversations.of({
      open: Effect.fn("Conversations.open")(function* (owner) {
        const conversation = {
          id: crypto.randomUUID(),
          chat: yield* Chat.empty,
          turn: yield* Semaphore.make(1),
        };

        kept.set(key(owner, conversation.id), conversation);

        return conversation;
      }),
      find: (owner, id) =>
        Effect.fromNullishOr(kept.get(key(owner, id))).pipe(
          Effect.mapError(() => new ConversationNotFound({ conversation: id })),
        ),
      end: (owner, id) => Effect.sync(() => kept.delete(key(owner, id))),
    });
  });
}
