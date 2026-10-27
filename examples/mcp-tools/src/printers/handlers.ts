import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Effect } from "effect";

import { PrintFarm } from "./farm.js";
import { Printers } from "./Printers.js";

// The builder runs once, when the server starts, whichever transport serves the tools: it is
// where the handlers get the farm, already signed in. Each handler is a step from a tool's
// input to the service and back to the tool's success. None handles a failure: the service
// fails only with `PrintFarmError`, which every tool declares, so it reaches the model as is.
// Public actions take no `authorize`.
export const printers = Action.implement(
  Printers,
  Effect.gen(function* () {
    const farm = yield* PrintFarm;

    return {
      list_printers: () =>
        Effect.map(farm.printers, (all) => ({ printers: all })),
      // Returned as `{ data, mimeType }` like any other field: the MCP surface makes the block.
      get_camera_snapshot: ({ printer_id }) =>
        Effect.all(
          {
            printer: farm.printer(printer_id),
            image: farm.snapshot(printer_id),
          },
          { concurrency: "unbounded" }
        ),
      start_print: ({ printer_id, file }) => farm.start(printer_id, file),
      set_paused: ({ printer_id, paused }) =>
        farm.setPaused(printer_id, paused),
      cancel_print: ({ printer_id }) => farm.cancel(printer_id),
    };
  })
);
