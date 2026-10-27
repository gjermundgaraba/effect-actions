import { expect, it } from "@effect/vitest";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Arbitrary, Array, Effect, References, Schema } from "effect";

import { notes } from "../../src/notes/handlers.js";
import { CreateNote, RequestConflict } from "../../src/notes/Notes.js";
import { NoteStore } from "../../src/notes/store.js";
import { as } from "./as.js";

it.effect("creates a new note on every call without a request key", () =>
  Effect.gen(function* () {
    const client = yield* Action.client(notes);
    const input = { title: "Plan", body: "Draft" };
    const first = yield* client.createNote(input);
    const second = yield* client.createNote(input);

    expect(second.id).not.toBe(first.id);
    expect(yield* client.listNotes()).toStrictEqual({
      notes: [
        { id: first.id, title: input.title },
        { id: second.id, title: input.title },
      ],
    });
  }).pipe(as("ada"), Effect.provide(NoteStore.layerMemory))
);

it.effect.prop(
  "replays a creation with the same key and content",
  {
    input: Arbitrary.schema(
      Schema.Struct({
        ...CreateNote.input.fields,
        requestId: Schema.requiredKey(CreateNote.input.fields.requestId),
      })
    ),
  },
  ({ input }) =>
    Effect.gen(function* () {
      const client = yield* Action.client(notes);
      const first = yield* client.createNote(input);
      const replay = yield* client.createNote(input);

      expect(first).toMatchObject({
        title: input.title,
        body: input.body,
        revision: 1,
      });
      expect(replay).toStrictEqual(first);
      expect(yield* client.listNotes()).toStrictEqual({
        notes: [{ id: first.id, title: input.title }],
      });
    }).pipe(as("ada"), Effect.provide(NoteStore.layerMemory))
);

it.effect.each([
  { title: "Changed", body: "Draft" },
  { title: "Plan", body: "Changed" },
])("refuses reuse of a key with changed content: %j", (changed) =>
  Effect.gen(function* () {
    const client = yield* Action.client(notes);
    const input = { requestId: "plan", title: "Plan", body: "Draft" };
    const first = yield* client.createNote(input);

    expect(
      yield* Effect.flip(
        client.createNote({ requestId: input.requestId, ...changed })
      )
    ).toStrictEqual(new RequestConflict({ requestId: input.requestId }));
    expect(yield* client.createNote(input)).toStrictEqual(first);
    expect(yield* client.listNotes()).toStrictEqual({
      notes: [{ id: first.id, title: "Plan" }],
    });
  }).pipe(as("ada"), Effect.provide(NoteStore.layerMemory))
);

it.effect(
  "scopes keys to the caller, and treats a new key as a new creation",
  () =>
    Effect.gen(function* () {
      const client = yield* Action.client(notes);
      const input = { requestId: "plan", title: "Plan", body: "Draft" };
      const ada = yield* client.createNote(input).pipe(as("ada"));

      const grace = yield* client
        .createNote({ ...input, body: "Grace's draft" })
        .pipe(as("grace"));

      const another = yield* client
        .createNote({ ...input, requestId: "another" })
        .pipe(as("ada"));

      expect(new Set([ada.id, grace.id, another.id]).size).toBe(3);
      expect(yield* client.createNote(input).pipe(as("ada"))).toStrictEqual(
        ada
      );
      expect(yield* client.listNotes().pipe(as("ada"))).toStrictEqual({
        notes: [
          { id: ada.id, title: "Plan" },
          { id: another.id, title: "Plan" },
        ],
      });
      expect(yield* client.listNotes().pipe(as("grace"))).toStrictEqual({
        notes: [{ id: grace.id, title: "Plan" }],
      });
    }).pipe(Effect.provide(NoteStore.layerMemory))
);

it.effect(
  "retains the original result after the note changes or is deleted",
  () =>
    Effect.gen(function* () {
      const client = yield* Action.client(notes);
      const input = { requestId: "plan", title: "Plan", body: "Draft" };
      const original = yield* client.createNote(input);

      yield* client.updateNote({ id: original.id, body: "Final", revision: 1 });

      expect(yield* client.createNote(input)).toStrictEqual(original);
      expect(yield* client.getNote({ id: original.id })).toMatchObject({
        body: "Final",
        revision: 2,
      });

      yield* client.deleteNote({ id: original.id });

      expect(yield* client.createNote(input)).toStrictEqual(original);
      expect(yield* client.listNotes()).toStrictEqual({ notes: [] });
    }).pipe(as("ada"), Effect.provide(NoteStore.layerMemory))
);

it.effect(
  "creates one note for concurrent duplicates, including under frequent fiber yields",
  () =>
    Effect.gen(function* () {
      const client = yield* Action.client(notes);
      const steps = Array.range(3, 60);

      yield* Effect.forEach(steps, (limit) =>
        Effect.gen(function* () {
          const input = {
            requestId: `concurrent-${limit}`,
            title: "Plan",
            body: "Draft",
          };

          const created = yield* Effect.all(
            Array.replicate(client.createNote(input), 3),
            {
              concurrency: "unbounded",
            }
          ).pipe(Effect.provideService(References.MaxOpsBeforeYield, limit));

          expect(created).toStrictEqual(Array.replicate(created[0], 3));
        })
      );

      expect((yield* client.listNotes()).notes).toHaveLength(steps.length);
    }).pipe(as("ada"), Effect.provide(NoteStore.layerMemory))
);
