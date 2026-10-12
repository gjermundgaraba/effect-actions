import { Context, Effect, Layer } from "effect";
import { type Note, NoteChanged, NoteNotFound } from "./Notes.js";

/**
 * Where notes live, each owned by one user. Ownership is checked here, in the data access, so no
 * surface and no handler can skip it.
 */
export class NoteStore extends Context.Service<
  NoteStore,
  {
    readonly list: (owner: string) => Effect.Effect<ReadonlyArray<Note>>;
    readonly get: (owner: string, id: string) => Effect.Effect<Note, NoteNotFound>;
    readonly create: (owner: string, title: string, body: string) => Effect.Effect<Note>;
    readonly update: (
      owner: string,
      id: string,
      body: string,
      revision: number,
    ) => Effect.Effect<Note, NoteNotFound | NoteChanged>;
    readonly remove: (owner: string, id: string) => Effect.Effect<void, NoteNotFound>;
    readonly count: Effect.Effect<number>;
  }
>()("notes-service/NoteStore") {
  // DEMO ONLY: memory, lost when the process stops. A real store is another Layer of this
  // service, chosen by the entrypoint.
  static readonly layerMemory = Layer.sync(NoteStore, () => {
    // One map per owner: a note is only ever looked up among its owner's, whatever id is asked.
    const notes = new Map<string, Map<string, Note>>();

    const ownedBy = (owner: string) => notes.get(owner) ?? new Map<string, Note>();

    const save = (owner: string, note: Note) => {
      notes.set(owner, ownedBy(owner).set(note.id, note));

      return note;
    };

    const get = Effect.fn("NoteStore.get")(function* (owner: string, id: string) {
      const note = ownedBy(owner).get(id);

      if (note === undefined) return yield* new NoteNotFound({ id });

      return note;
    });

    return NoteStore.of({
      list: (owner) => Effect.sync(() => Array.from(ownedBy(owner).values())),
      get,
      create: (owner, title, body) =>
        Effect.sync(() => save(owner, { id: crypto.randomUUID(), title, body, revision: 1 })),
      update: Effect.fn("NoteStore.update")(function* (owner, id, body, revision) {
        const current = yield* get(owner, id);

        if (current.revision !== revision) {
          return yield* new NoteChanged({ id, revision: current.revision });
        }

        return save(owner, { ...current, body, revision: revision + 1 });
      }),
      remove: Effect.fn("NoteStore.remove")(function* (owner, id) {
        yield* get(owner, id);
        ownedBy(owner).delete(id);
      }),
      count: Effect.sync(() =>
        Array.from(notes.values()).reduce((total, owned) => total + owned.size, 0),
      ),
    });
  });
}
