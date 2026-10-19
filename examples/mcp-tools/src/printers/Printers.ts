import { Schema } from "effect";
import * as Action from "@gjermundgaraba/effect-actions/Action";

export const Printer = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  state: Schema.Literals(["idle", "printing", "paused", "offline"]),
  job: Schema.NullOr(
    Schema.Struct({
      file: Schema.String,
      progress: Schema.Finite.annotate({ description: "Percent done, 0 to 100." }),
    }),
  ),
});

export type Printer = typeof Printer.Type;

// The one error every tool declares: the farm could not do what was asked. A model reads its
// `message` and decides what to do next, so the message says what went wrong in plain words.
// A handler failing with an error its action does not declare does not compile.
export class PrintFarmError extends Schema.TaggedError<PrintFarmError>()("PrintFarmError", {
  message: Schema.String,
}) {}

// A field's description is part of the tool's input schema, which is all a model knows of it.
// The pattern is there for safety: an id becomes a segment of the farm's URL, and it comes
// from a model. An id that does not match is refused as invalid input, on every surface,
// before a handler runs, so `..` or `a/b` never reaches the farm. The `u` flag is what puts the
// pattern in the tool's schema, where the model reads it.
const PrinterId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/u)).annotate({
  description: "A printer's id, as list_printers gives it, such as mk4-1.",
});

// What every tool here shares. `caller: Action.Anyone` makes an action public: this server
// authenticates nobody, so it is reachable by whoever can reach the process.
const tool = { caller: Action.Anyone, error: PrintFarmError } as const;

// The names are snake_case because this server is tools only, and that is the convention MCP
// tool names usually follow. An application whose actions are also typed client methods or CLI
// commands names them in camelCase, as notes-service does.
//
// A description is written for the model that picks the tool: what it does, when to call it,
// and what it answers. `readOnly` is sent as the tool's read-only hint; `mcp` holds the other
// hints and the title a client shows its user.
export const ListPrinters = Action.make("list_printers", {
  ...tool,
  description:
    "List every printer of the farm: its id, name, state (idle, printing, paused or offline) " +
    "and, when it has a job, the file being printed and its progress. Call this first: every " +
    "other tool takes a printer id from this list.",
  success: { printers: Schema.Array(Printer) },
  readOnly: true,
  mcp: { title: "List printers" },
});

// `image` is an `Action.Image` beside an ordinary field. Over MCP it is sent as an image block
// the model can look at, after the JSON of `{ printer }`.
export const GetCameraSnapshot = Action.make("get_camera_snapshot", {
  ...tool,
  description:
    "Take a picture with a printer's camera, to judge a print by eye before pausing or " +
    "cancelling it. Answers with the printer's state at that moment and the picture. An " +
    "offline printer has no picture.",
  input: { printer_id: PrinterId },
  success: { printer: Printer, image: Action.Image },
  readOnly: true,
  mcp: { title: "Camera snapshot" },
});

// Destructive, MCP's default for a write: a print sets a machine to work and spends material,
// which is more than adding a record. A second call is refused, so it is not idempotent.
export const StartPrint = Action.make("start_print", {
  ...tool,
  description:
    "Start printing a file on an idle printer. The file is one already uploaded to the farm, " +
    "named as the farm stores it. Refused when the printer is not idle.",
  input: {
    printer_id: PrinterId,
    file: Schema.String.annotate({ description: "A G-code file's name, such as bracket.gcode." }),
  },
  success: Printer,
  readOnly: false,
  mcp: { title: "Start a print" },
});

// Idempotent: the same call again leaves the printer as the first left it.
export const SetPaused = Action.make("set_paused", {
  ...tool,
  description:
    "Pause a printer's job, or resume a paused one. A paused job keeps its progress, so " +
    "pausing is the safe move while deciding what to do with a print that looks wrong.",
  input: {
    printer_id: PrinterId,
    paused: Schema.Boolean.annotate({ description: "true to pause the job, false to resume it." }),
  },
  success: Printer,
  readOnly: false,
  // Destructive, MCP's default for a write: a pause interrupts a running print.
  mcp: { title: "Pause or resume a print", idempotentHint: true },
});

export const CancelPrint = Action.make("cancel_print", {
  ...tool,
  description:
    "Cancel a printer's job for good. The print is abandoned and cannot be resumed, only " +
    "started again from the beginning. A printer without a job is left as it is.",
  input: { printer_id: PrinterId },
  success: Printer,
  readOnly: false,
  mcp: { title: "Cancel a print", idempotentHint: true },
});

export const Printers = [
  ListPrinters,
  GetCameraSnapshot,
  StartPrint,
  SetPaused,
  CancelPrint,
] as const;
