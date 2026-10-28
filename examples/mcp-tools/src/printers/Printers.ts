import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Schema } from "effect";

export const Printer = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  state: Schema.Literals(["idle", "printing", "paused", "offline"]),
  job: Schema.NullOr(
    Schema.Struct({
      file: Schema.String,
      progress: Schema.Finite.annotate({
        description: "Percent done, 0 to 100.",
      }),
    })
  ),
});

export type Printer = typeof Printer.Type;

export class PrintFarmError extends Schema.TaggedError<
  PrintFarmError,
  { readonly brand: unique symbol }
>()("PrintFarmError", {
  message: Schema.String,
}) {}

const PrinterId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]+$/u)
).annotate({
  description: "A printer's id, as list_printers gives it, such as mk4-1.",
});

const tool = { caller: Action.Anyone, error: PrintFarmError } as const;

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

export const StartPrint = Action.make("start_print", {
  ...tool,
  description:
    "Start printing a file on an idle printer. The file is one already uploaded to the farm, " +
    "named as the farm stores it. Refused when the printer is not idle.",
  input: {
    printer_id: PrinterId,
    file: Schema.String.annotate({
      description: "A G-code file's name, such as bracket.gcode.",
    }),
  },
  success: Printer,
  readOnly: false,
  mcp: { title: "Start a print" },
});

export const SetPaused = Action.make("set_paused", {
  ...tool,
  description:
    "Pause a printer's job, or resume a paused one. A paused job keeps its progress, so " +
    "pausing is the safe move while deciding what to do with a print that looks wrong.",
  input: {
    printer_id: PrinterId,
    paused: Schema.Boolean.annotate({
      description: "true to pause the job, false to resume it.",
    }),
  },
  success: Printer,
  readOnly: false,
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
