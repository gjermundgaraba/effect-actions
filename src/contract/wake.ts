import { Context } from "effect";
import type { Effect } from "effect";

/**
 * How an entity's activation waits until a time, which `ActionEntity.layer` provides to its
 * `services`: a wait that builds a stopped activation again when it is due, where a timer is cut
 * by Effect's reaper and keeps a Durable Object awake. Absent outside an entity.
 */
export class Wake extends Context.Service<
  Wake,
  { readonly until: (at: number) => Effect.Effect<void> }
>()("effect-actions/Wake") {}
