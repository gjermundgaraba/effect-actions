import { describe, expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Effect } from "effect";

import { CurrentUser } from "../../src/identity/Identity.js";
import { demoUsers } from "../../src/identity/users.js";
import { notes } from "../../src/notes/handlers.js";
import { NoteNotFound } from "../../src/notes/Notes.js";
import { NoteStore } from "../../src/notes/store.js";

const as = (user: keyof typeof demoUsers) =>
  Effect.provideService(CurrentUser, demoUsers[user]);

describe("notes, in process", () => {
  it.effect("keeps each user's notes their own", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(notes);

      const note = yield* client
        .createNote({ title: "Plan", body: "Draft" })
        .pipe(as("ada"));

      expect(yield* client.listNotes().pipe(as("ada"))).toStrictEqual({
        notes: [{ id: note.id, title: "Plan" }],
      });
      expect(yield* client.listNotes().pipe(as("grace"))).toStrictEqual({
        notes: [],
      });

      const missing = new NoteNotFound({ id: note.id });
      const update = { id: note.id, body: "Mine now", revision: note.revision };

      expect(
        yield* Effect.flip(client.getNote({ id: note.id }).pipe(as("grace")))
      ).toStrictEqual(missing);
      expect(
        yield* Effect.flip(client.updateNote(update).pipe(as("grace")))
      ).toStrictEqual(missing);
      expect(
        yield* Effect.flip(client.deleteNote({ id: note.id }).pipe(as("grace")))
      ).toStrictEqual(missing);
      expect(
        yield* client.getNote({ id: note.id }).pipe(as("ada"))
      ).toStrictEqual(note);
    }).pipe(Effect.provide(NoteStore.layerMemory))
  );

  it.effect("refuses a write from a caller holding the read scope alone", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(notes);
      const create = client.createNote({ title: "Plan", body: "Draft" });
      const refusal = yield* Effect.flip(create.pipe(as("reader")));

      expect(refusal).toBeInstanceOf(Action.Forbidden);
      expect(refusal.message).toBe("Requires notes:write.");
    }).pipe(Effect.provide(NoteStore.layerMemory))
  );
});
