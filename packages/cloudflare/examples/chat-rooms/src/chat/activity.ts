import { Context, type Effect } from "effect";

/**
 * Where a room says its latest activity may have changed: the lobby's object, which worker.ts
 * chooses. `changing` runs a change, then tells, answering as the change did: a post stands
 * whether the lobby hears of it or not.
 */
export class Activity extends Context.Service<
  Activity,
  {
    readonly changing: <A, E, R>(change: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("chat-rooms/Activity") {}
