import { Context, Effect, Layer, Semaphore } from "effect";
import { Chat } from "effect/ai";

import type { Member } from "../identity/Identity.js";
import { ConversationNotFound } from "./Assistant.js";

interface Conversation {
  readonly chat: Chat.Chat;
  readonly lock: Semaphore.Semaphore;
}

const keyOf = (owner: Member, id: string) =>
  JSON.stringify([owner.workspace, owner.id, id]);

export class Conversations extends Context.Service<
  Conversations,
  {
    readonly open: (owner: Member) => Effect.Effect<string>;
    readonly turn: <A, E, R>(
      owner: Member,
      id: string,
      run: (chat: Chat.Chat) => Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E | ConversationNotFound, R>;
  }
>()("tracker/Conversations") {
  static readonly layerMemory = Layer.sync(Conversations, () => {
    const kept = new Map<string, Conversation>();

    const find = (key: string, id: string) =>
      Effect.suspend(() => Effect.fromNullishOr(kept.get(key))).pipe(
        Effect.mapError(() => new ConversationNotFound({ conversation: id }))
      );

    return Conversations.of({
      open: Effect.fn("Conversations.open")(function* (owner) {
        const id = crypto.randomUUID();

        kept.set(keyOf(owner, id), {
          chat: yield* Chat.empty,
          lock: yield* Semaphore.make(1),
        });

        return id;
      }),
      turn: (owner, id, run) => {
        const key = keyOf(owner, id);

        const lookupUnderLock = find(key, id);

        return Effect.flatMap(find(key, id), ({ lock }) =>
          Effect.flatMap(lookupUnderLock, ({ chat }) =>
            Effect.onError(run(chat), () => Effect.sync(() => kept.delete(key)))
          ).pipe(lock.withPermits(1))
        );
      },
    });
  });
}
