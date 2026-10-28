import { describe, expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Array, Effect, Exit, References } from "effect";

import { notes } from "../../src/notes/handlers.js";
import { NoteChanged, NoteNotFound } from "../../src/notes/Notes.js";
import { NoteStore } from "../../src/notes/store.js";
import { as } from "./as.js";

describe("notes, in process", () => {
  it.effect("deletes a note for its owner", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(notes);

      const note = yield* client
        .createNote({ title: "Plan", body: "Draft" })
        .pipe(as("ada"));

      yield* client.deleteNote({ id: note.id }).pipe(as("ada"));

      expect(
        yield* Effect.flip(client.getNote({ id: note.id }).pipe(as("ada")))
      ).toStrictEqual(new NoteNotFound({ id: note.id }));
    }).pipe(Effect.provide(NoteStore.layerMemory))
  );

  it.effect("refuses an update of a revision that is no longer current", () =>
    Effect.gen(function* () {
      const client = yield* Action.client(notes);

      const note = yield* client
        .createNote({ title: "Plan", body: "Draft" })
        .pipe(as("ada"));

      const update = { id: note.id, body: "Final", revision: note.revision };

      expect(yield* client.updateNote(update).pipe(as("ada"))).toMatchObject({
        revision: 2,
      });
      expect(
        yield* Effect.flip(client.updateNote(update).pipe(as("ada")))
      ).toStrictEqual(new NoteChanged({ id: note.id, revision: 2 }));
    }).pipe(Effect.provide(NoteStore.layerMemory))
  );

  it.effect(
    "lets one of two concurrent updates of the same revision through",
    () =>
      Effect.gen(function* () {
        const client = yield* Action.client(notes);

        const succeeded = yield* Effect.forEach(Array.range(3, 60), (steps) =>
          Effect.gen(function* () {
            const note = yield* client
              .createNote({ title: "Plan", body: "Draft" })
              .pipe(as("ada"));

            const update = (body: string) =>
              Effect.exit(
                client
                  .updateNote({ id: note.id, body, revision: 1 })
                  .pipe(as("ada"))
              );

            const exits = yield* Effect.all([update("One"), update("Two")], {
              concurrency: "unbounded",
            }).pipe(Effect.provideService(References.MaxOpsBeforeYield, steps));

            return exits.filter(Exit.isSuccess).length;
          })
        );

        expect(succeeded).toStrictEqual(Array.range(3, 60).map(() => 1));
      }).pipe(Effect.provide(NoteStore.layerMemory))
  );
});
