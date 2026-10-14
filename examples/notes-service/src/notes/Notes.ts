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

export class RequestConflict extends Schema.TaggedError<RequestConflict>()(
  "RequestConflict",
  { requestId: Schema.String },
  { httpApiStatus: 409 },
) {}

// A description on an input field is that field's help on every surface: beside its flag or
// argument in a command's `--help`, and in the input schema a model reads from the MCP tool
// listing and the OpenAPI document. A field without one has a flag with no help.
const Id = Schema.String.annotate({
  description: "The note's id, as the list of your notes shows it.",
});

// A check's `message` is what a caller reads when the value fails it, in place of the
// generic "Expected a value with a length of at least 1". A model and a CLI user read it too.
const Title = Schema.String.check(
  Schema.isMinLength(1, { message: "A note needs a title." }),
  Schema.isPattern(/^[^\r\n\u2028\u2029]*$/u, { message: "A title is one line." }),
).annotate({
  description: "A short name for the note: one line, at least one character.",
});

const Body = Schema.String.annotate({ description: "The note's whole text." });

const Content = Schema.Struct({ title: Title, body: Body });

export const ListNotes = Action.make("listNotes", {
  description: "List your notes, without their bodies.",
  success: { notes: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String })) },
  readOnly: true,
  caller: CurrentUser,
});

export const GetNote = Action.make("getNote", {
  description: "Read one of your notes.",
  input: { id: Id },
  success: Note,
  error: NoteNotFound,
  readOnly: true,
  caller: CurrentUser,
});

export const CreateNote = Action.make("createNote", {
  description:
    "Create a note. To retry safely, supply a requestId and reuse it with the same content.",
  input: {
    requestId: Schema.optionalKey(Schema.NonEmptyString).annotate({
      description:
        "An optional key for this creation. Keep it for retries; without one, every call creates a note.",
    }),
    ...Content.fields,
  },
  success: Note,
  error: RequestConflict,
  readOnly: false,
  caller: CurrentUser,
  mcp: { destructiveHint: false },
});

export const UpdateNote = Action.make("updateNote", {
  description:
    "Replace a note's body. Pass the revision you read: the update is refused if the note changed since.",
  input: {
    id: Id,
    body: Body.annotate({ description: "The text that replaces the note's body." }),
    revision: Schema.Finite.annotate({
      description: "The revision you read: 1 for a new note, one more after each update.",
    }),
  },
  success: Note,
  error: [NoteNotFound, NoteChanged],
  readOnly: false,
  caller: CurrentUser,
  // No `destructiveHint`: an update replaces the body, so it is destructive, MCP's default for
  // a write, as is any update of what is stored, a flag such as "read" included.
  // `createNote` and `importNotes`, which only add, say `false`.
});

export const DeleteNote = Action.make("deleteNote", {
  description: "Delete a note for good.",
  input: { id: Id },
  error: NoteNotFound,
  readOnly: false,
  caller: CurrentUser,
});

// Work every surface should offer is an action, a bulk import included: the HTTP API, the MCP
// tools and the CLI then all have it, and the whole list is decoded, so checked, before the
// handler writes any of it. A command of your own only reads the file and calls this once
// (commands.ts). `importNotes` only adds notes, so `destructiveHint` is `false`.
// Imports share note content with `createNote`, but exclude request keys because bulk creation
// does not deduplicate.
export const ImportNotes = Action.make("importNotes", {
  description:
    "Create several notes at once, such as those `notes export` wrote. Every note is checked " +
    "before any is written: an import holding one that is not valid writes none.",
  input: {
    notes: Schema.Array(Content)
      .check(
        Schema.isMinLength(1, { message: "An import holds at least one note." }),
        Schema.isMaxLength(100, { message: "An import holds at most 100 notes." }),
      )
      .annotate({ description: "The notes to create, in order: from 1 to 100." }),
  },
  success: { notes: Schema.Array(Note) },
  readOnly: false,
  caller: CurrentUser,
  mcp: { destructiveHint: false },
});

export const Notes = [ListNotes, GetNote, CreateNote, UpdateNote, DeleteNote, ImportNotes] as const;
