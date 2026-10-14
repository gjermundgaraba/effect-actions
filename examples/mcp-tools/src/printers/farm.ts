import { Context, type Effect } from "effect";
import type * as Action from "@gjermundgaraba/effect-actions/Action";
import type { Printer, PrintFarmError } from "./Printers.js";

/**
 * The print farm, the one upstream of this server. Its methods require nothing and fail only
 * with the error the tools declare: its layer, `printFarm` in src/platform/print-farm.ts, has
 * captured the HTTP client, the farm's URL and the session.
 */
export class PrintFarm extends Context.Service<
  PrintFarm,
  {
    readonly printers: Effect.Effect<ReadonlyArray<Printer>, PrintFarmError>;
    readonly printer: (id: string) => Effect.Effect<Printer, PrintFarmError>;
    readonly snapshot: (id: string) => Effect.Effect<typeof Action.Image.Type, PrintFarmError>;
    readonly start: (id: string, file: string) => Effect.Effect<Printer, PrintFarmError>;
    readonly setPaused: (id: string, paused: boolean) => Effect.Effect<Printer, PrintFarmError>;
    readonly cancel: (id: string) => Effect.Effect<Printer, PrintFarmError>;
  }
>()("mcp-tools/PrintFarm") {}
