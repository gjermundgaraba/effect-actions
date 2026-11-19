import { Context } from "effect";
import type { DateTime, Effect } from "effect";

import type { Unavailable } from "./errors.js";

/**
 * An entity's wake, which `ActionEntity.layer` provides to its activation: `wakeAt` schedules the
 * persisted tell `ActionEntity.wakeAt` promises, and `until` waits in the activation for one, so
 * a stopped activation is built again when it is due, where a timer is cut by Effect's reaper and
 * keeps a Durable Object awake. Absent outside an entity.
 */
export class Wake extends Context.Service<
  Wake,
  {
    readonly wakeAt: (
      at: DateTime.DateTime
    ) => Effect.Effect<void, Unavailable>;
    readonly until: (at: number) => Effect.Effect<void>;
  }
>()("effect-actions/Wake") {}
