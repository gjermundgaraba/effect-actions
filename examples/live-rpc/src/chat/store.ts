import { Context, Effect, Layer } from "effect";
import { type Message, MessageNotFound, NotAuthor } from "./Chat.js";

/**
 * Where messages live, by room. That only its author deletes a message is checked here, in the
 * data access, so no surface and no handler can skip it.
 */
export class MessageStore extends Context.Service<
  MessageStore,
  {
    /** The store's epoch: a message's id is unique within it, and a restarted memory store starts another. */
    readonly epoch: string;
    readonly rooms: Effect.Effect<ReadonlyArray<{ name: string; messages: number }>>;
    readonly read: (room: string, after: number) => Effect.Effect<ReadonlyArray<Message>>;
    /** The id of the room's last message posted, kept or deleted: 0 for an empty room. */
    readonly last: (room: string) => Effect.Effect<number>;
    readonly post: (room: string, author: string, text: string) => Effect.Effect<Message>;
    readonly remove: (
      room: string,
      author: string,
      id: number,
    ) => Effect.Effect<void, MessageNotFound | NotAuthor>;
  }
>()("live-rpc/MessageStore") {
  // DEMO ONLY: memory, lost when the process stops, its ids then counting from 1 again, so each
  // start is another epoch. A real store is another Layer of this service, chosen by the
  // entrypoint, whose ids never repeat.
  static readonly layerMemory = Layer.sync(MessageStore, () => {
    const epoch = crypto.randomUUID();
    const rooms = new Map<string, { last: number; messages: ReadonlyArray<Message> }>();

    const room = (name: string) => rooms.get(name) ?? { last: 0, messages: [] };

    return MessageStore.of({
      epoch,
      rooms: Effect.sync(() =>
        Array.from(rooms, ([name, { messages }]) => ({ name, messages: messages.length })),
      ),
      read: (name, after) => Effect.sync(() => room(name).messages.filter(({ id }) => id > after)),
      last: (name) => Effect.sync(() => room(name).last),
      post: (name, author, text) =>
        Effect.sync(() => {
          const { last, messages } = room(name);
          const message = { id: last + 1, author, text };

          rooms.set(name, { last: message.id, messages: [...messages, message] });

          return message;
        }),
      remove: Effect.fn("MessageStore.remove")(function* (name, author, id) {
        const { last, messages } = room(name);
        const message = messages.find((candidate) => candidate.id === id);

        if (message === undefined) return yield* new MessageNotFound({ id });

        if (message.author !== author) return yield* new NotAuthor({ id });

        rooms.set(name, { last, messages: messages.filter((kept) => kept !== message) });
      }),
    });
  });
}
