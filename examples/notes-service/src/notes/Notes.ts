import { Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";
import { CurrentUser } from "../identity/Identity.js";

export const Note = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  body: Schema.String,
  revision: Schema.Finite,
});

export type Note = typeof Note.Type;

// A declared error is part of the contract: every client decodes it as this class, and its
// status is what HTTP answers with.
export class NoteNotFound extends Schema.TaggedError<NoteNotFound>()(
  "NoteNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

export class NoteChanged extends Schema.TaggedError<NoteChanged>()(
  "NoteChanged",
  { id: Schema.String, revision: Schema.Finite },
  { httpApiStatus: 409 },
) {}

const Title = Schema.String.check(Schema.isMinLength(1));

export const ListNotes = Action.make("listNotes", {
  description: "List your notes, without their bodies.",
  success: { notes: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String })) },
  readOnly: true,
  caller: CurrentUser,
});

export const GetNote = Action.make("getNote", {
  description: "Read one of your notes.",
  input: { id: Schema.String },
  success: Note,
  error: NoteNotFound,
  readOnly: true,
  caller: CurrentUser,
});

export const CreateNote = Action.make("createNote", {
  description: "Create a note.",
  input: { title: Title, body: Schema.String },
  success: Note,
  readOnly: false,
  caller: CurrentUser,
  mcp: { destructiveHint: false },
});

export const UpdateNote = Action.make("updateNote", {
  description:
    "Replace a note's body. Pass the revision you read: the update is refused if the note changed since.",
  input: { id: Schema.String, body: Schema.String, revision: Schema.Finite },
  success: Note,
  error: [NoteNotFound, NoteChanged],
  readOnly: false,
  caller: CurrentUser,
  mcp: { destructiveHint: false },
});

export const DeleteNote = Action.make("deleteNote", {
  description: "Delete a note for good.",
  input: { id: Schema.String },
  error: NoteNotFound,
  readOnly: false,
  caller: CurrentUser,
});

export const Notes = [ListNotes, GetNote, CreateNote, UpdateNote, DeleteNote] as const;
