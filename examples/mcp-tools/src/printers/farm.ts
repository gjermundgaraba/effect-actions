import type * as Action from "@gjermundgaraba/effect-actions/Action";
import { Context } from "effect";
import type { Effect } from "effect";

import type { Printer, PrintFarmError } from "./Printers.js";

export class PrintFarm extends Context.Service<
  PrintFarm,
  {
    readonly printers: Effect.Effect<readonly Printer[], PrintFarmError>;
    readonly printer: (id: string) => Effect.Effect<Printer, PrintFarmError>;
    readonly snapshot: (
      id: string
    ) => Effect.Effect<typeof Action.Image.Type, PrintFarmError>;
    readonly start: (
      id: string,
      file: string
    ) => Effect.Effect<Printer, PrintFarmError>;
    readonly setPaused: (
      id: string,
      paused: boolean
    ) => Effect.Effect<Printer, PrintFarmError>;
    readonly cancel: (id: string) => Effect.Effect<Printer, PrintFarmError>;
  }
>()("mcp-tools/PrintFarm") {}
