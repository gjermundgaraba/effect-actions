import { Context } from "effect";
import type { Effect } from "effect";

export class Activity extends Context.Service<
  Activity,
  {
    readonly changing: <A, E, R>(
      change: Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E, R>;
  }
>()("chat-rooms/Activity") {}
