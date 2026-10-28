import { Context, Effect, Layer } from "effect";

import { NoteChanged, NoteNotFound, RequestConflict } from "./Notes.js";
import type { Note } from "./Notes.js";

export class NoteStore extends Context.Service<
  NoteStore,
  {
    readonly list: (owner: string) => Effect.Effect<readonly Note[]>;
    readonly get: (
      owner: string,
      id: string
    ) => Effect.Effect<Note, NoteNotFound>;
    readonly create: (
      owner: string,
      title: string,
      body: string,
      requestId?: string
    ) => Effect.Effect<Note, RequestConflict>;
    readonly createAll: (
      owner: string,
      notes: ReadonlyArray<{ readonly title: string; readonly body: string }>
    ) => Effect.Effect<readonly Note[]>;
    readonly update: (
      owner: string,
      id: string,
      body: string,
      revision: number
    ) => Effect.Effect<Note, NoteNotFound | NoteChanged>;
    readonly remove: (
      owner: string,
      id: string
    ) => Effect.Effect<void, NoteNotFound>;
    readonly count: Effect.Effect<number>;
  }
>()("notes-service/NoteStore") {
  static readonly layerMemory = Layer.sync(NoteStore, () => {
    const notes = new Map<string, Map<string, Note>>();

    const creations = new Map<string, Map<string, Note>>();

    const ownedBy = (owner: string) =>
      notes.get(owner) ?? new Map<string, Note>();

    const save = (owner: string, note: Note) => {
      notes.set(owner, ownedBy(owner).set(note.id, note));

      return note;
    };

    const createdAtomically = (
      owner: string,
      title: string,
      body: string,
      requestId: string | undefined
    ): Note | RequestConflict => {
      if (requestId !== undefined) {
        const recorded = creations.get(owner)?.get(requestId);

        if (recorded !== undefined) {
          return recorded.title === title && recorded.body === body
            ? recorded
            : new RequestConflict({ requestId });
        }
      }

      const note = save(owner, {
        id: crypto.randomUUID(),
        title,
        body,
        revision: 1,
      });

      if (requestId !== undefined) {
        const requests = creations.get(owner) ?? new Map<string, Note>();
        requests.set(requestId, note);
        creations.set(owner, requests);
      }

      return note;
    };

    const updatedAtomically = (
      owner: string,
      id: string,
      body: string,
      revision: number
    ): Note | NoteNotFound | NoteChanged => {
      const current = ownedBy(owner).get(id);

      if (current === undefined) {
        return new NoteNotFound({ id });
      }

      if (current.revision !== revision) {
        return new NoteChanged({ id, revision: current.revision });
      }

      return save(owner, { ...current, body, revision: revision + 1 });
    };

    const get = Effect.fn("NoteStore.get")(function* (
      owner: string,
      id: string
    ) {
      const note = ownedBy(owner).get(id);

      if (note === undefined) {
        return yield* new NoteNotFound({ id });
      }

      return note;
    });

    return NoteStore.of({
      list: (owner) => Effect.sync(() => [...ownedBy(owner).values()]),
      get,
      create: Effect.fn("NoteStore.create")(
        function* (owner, title, body, requestId) {
          const created = createdAtomically(owner, title, body, requestId);

          if (created instanceof RequestConflict) {
            return yield* created;
          }

          return created;
        }
      ),
      createAll: (owner, all) =>
        Effect.sync(() =>
          all.map(({ title, body }) =>
            save(owner, { id: crypto.randomUUID(), title, body, revision: 1 })
          )
        ),
      update: Effect.fn("NoteStore.update")(
        function* (owner, id, body, revision) {
          const updated = updatedAtomically(owner, id, body, revision);

          if (
            updated instanceof NoteNotFound ||
            updated instanceof NoteChanged
          ) {
            return yield* updated;
          }

          return updated;
        }
      ),
      remove: Effect.fn("NoteStore.remove")(function* (owner, id) {
        if (!ownedBy(owner).delete(id)) {
          return yield* new NoteNotFound({ id });
        }
      }),
      count: Effect.sync(() =>
        [...notes.values()].reduce((total, owned) => total + owned.size, 0)
      ),
    });
  });
}
