import * as Action from "@gjermundgaraba/effect-actions/Action";
import { Effect } from "effect";

import { PrintFarm } from "./farm.js";
import { Printers } from "./Printers.js";

export const printers = Action.implement(
  Printers,
  Effect.gen(function* () {
    const farm = yield* PrintFarm;

    return {
      list_printers: () =>
        Effect.map(farm.printers, (all) => ({ printers: all })),
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
