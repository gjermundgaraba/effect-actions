import { Context, Effect, Layer } from "effect";
import { type Note, NoteChanged, NoteNotFound, RequestConflict } from "./Notes.js";

/**
 * Where notes live, each owned by one user. Ownership is checked here, in the data access, so no
 * surface and no handler can skip it.
 */
export class NoteStore extends Context.Service<
  NoteStore,
  {
    readonly list: (owner: string) => Effect.Effect<ReadonlyArray<Note>>;
    readonly get: (owner: string, id: string) => Effect.Effect<Note, NoteNotFound>;
    readonly create: (
      owner: string,
      title: string,
      body: string,
      requestId?: string,
    ) => Effect.Effect<Note, RequestConflict>;
    /** Every note or none: a database does this in one transaction. */
    readonly createAll: (
      owner: string,
      notes: ReadonlyArray<{ readonly title: string; readonly body: string }>,
    ) => Effect.Effect<ReadonlyArray<Note>>;
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
  // DEMO ONLY: notes and replay records live in this process's memory, without eviction.
  static readonly layerMemory = Layer.sync(NoteStore, () => {
    // One map per owner: a note is only ever looked up among its owner's, whatever id is asked.
    const notes = new Map<string, Map<string, Note>>();

    // Keep the original result even after the note is updated or deleted.
    const creations = new Map<string, Map<string, Note>>();

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
      create: Effect.fn("NoteStore.create")(function* (owner, title, body, requestId) {
        if (requestId !== undefined) {
          const recorded = creations.get(owner)?.get(requestId);

          if (recorded !== undefined) {
            if (recorded.title !== title || recorded.body !== body) {
              return yield* new RequestConflict({ requestId });
            }

            return recorded;
          }
        }

        // No yield between lookup, mutation and recording: concurrent calls cannot interleave
        // or interruption leave a note without its result.
        const note = save(owner, { id: crypto.randomUUID(), title, body, revision: 1 });

        if (requestId !== undefined) {
          const requests = creations.get(owner) ?? new Map<string, Note>();
          requests.set(requestId, note);
          creations.set(owner, requests);
        }

        return note;
      }),
      createAll: (owner, all) =>
        Effect.sync(() =>
          all.map(({ title, body }) =>
            save(owner, { id: crypto.randomUUID(), title, body, revision: 1 }),
          ),
        ),
      // No `yield*` between the read and the write: a fiber may be set aside at one, and two
      // updates that each read revision 1 before either wrote would both succeed. A database
      // does this with a conditional update or a transaction.
      update: Effect.fn("NoteStore.update")(function* (owner, id, body, revision) {
        const current = ownedBy(owner).get(id);

        if (current === undefined) return yield* new NoteNotFound({ id });

        if (current.revision !== revision) {
          return yield* new NoteChanged({ id, revision: current.revision });
        }

        return save(owner, { ...current, body, revision: revision + 1 });
      }),
      remove: Effect.fn("NoteStore.remove")(function* (owner, id) {
        if (!ownedBy(owner).delete(id)) return yield* new NoteNotFound({ id });
      }),
      count: Effect.sync(() =>
        Array.from(notes.values()).reduce((total, owned) => total + owned.size, 0),
      ),
    });
  });
}
