import { Context, Effect, Layer, Semaphore } from "effect";
import { Chat } from "effect/ai";
import type { Member } from "../identity/Identity.js";
import { ConversationNotFound } from "./Assistant.js";

interface Conversation {
  /** Effect's `Chat`: the history a model reads, in which an approval's answer finds its request. */
  readonly chat: Chat.Chat;
  readonly lock: Semaphore.Semaphore;
}

/**
 * Where conversations are kept between requests, each with the member it belongs to. A turn
 * names the member, so only its owner reaches a conversation: an approval is acted on as the
 * turn's caller, and must come from the member who was asked.
 */
export class Conversations extends Context.Service<
  Conversations,
  {
    /** Start a conversation of `owner`'s, and return its id. */
    readonly open: (owner: Member) => Effect.Effect<string>;
    /**
     * Run one turn on a conversation's `Chat`. One turn runs at a time, and a turn that fails or
     * is interrupted ends its conversation: the `Chat` records a turn only when it succeeds, so
     * after any other end its history no longer says which calls ran, and an approval answered
     * in that turn would run again.
     */
    readonly turn: <A, E, R>(
      owner: Member,
      id: string,
      run: (chat: Chat.Chat) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ConversationNotFound, R>;
  }
>()("tracker/Conversations") {
  // DEMO ONLY: memory, lost when the process stops and never trimmed. A real store keeps each
  // history where every instance reads it, `chat.exportJson` to save and `Chat.fromJson` to load.
  static readonly layerMemory = Layer.sync(Conversations, () => {
    const kept = new Map<string, Conversation>();

    // A member is a person in a workspace, and an id is unguessable: both are in the key, as
    // JSON, which keeps its three parts apart whatever they hold.
    const keyOf = (owner: Member, id: string) => JSON.stringify([owner.workspace, owner.id, id]);

    // Read when it runs, not when it is written: the second lookup of a turn runs under the lock.
    const find = (key: string, id: string) =>
      Effect.suspend(() => Effect.fromNullishOr(kept.get(key))).pipe(
        Effect.mapError(() => new ConversationNotFound({ conversation: id })),
      );

    return Conversations.of({
      open: Effect.fn("Conversations.open")(function* (owner) {
        const id = crypto.randomUUID();

        kept.set(keyOf(owner, id), { chat: yield* Chat.empty, lock: yield* Semaphore.make(1) });

        return id;
      }),
      turn: (owner, id, run) => {
        const key = keyOf(owner, id);

        return Effect.flatMap(find(key, id), ({ lock }) =>
          // Looked up again once the lock is held: a turn that waited for one that failed
          // must find its conversation gone, not run on the history that turn left behind.
          Effect.flatMap(find(key, id), ({ chat }) =>
            Effect.onError(run(chat), () => Effect.sync(() => kept.delete(key))),
          ).pipe(lock.withPermits(1)),
        );
      },
    });
  });
}
