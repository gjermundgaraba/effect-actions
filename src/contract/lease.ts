import { Context, Duration, Effect, Equal, Hash, RcMap, Scope } from "effect";
import type * as Event from "./Event.js";

type Input = Event.Any["input"]["Type"];

/** A poll subscription's key, held with the context of the poll that first acquired it. */
class Lease implements Equal.Equal {
  constructor(
    readonly key: string,
    readonly input: Input,
    readonly context: Context.Context<never>,
  ) {}

  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof Lease && that.key === this.key;
  }

  [Hash.symbol](): number {
    return Hash.string(this.key);
  }
}

/**
 * The poll subscriptions of an event type with a `subscription` hook: polls of one key share one
 * acquisition, released `ttl` after the last of them.
 */
export interface Leases {
  readonly hold: (key: string, input: Input) => Effect.Effect<void>;
}

const defaultLease = Duration.minutes(5);

export const makeLeases = (
  subscription: (input: Input) => Effect.Effect<void, never, unknown>,
  ttl: Duration.Input = defaultLease,
): Effect.Effect<Leases, never, unknown> =>
  Effect.map(
    RcMap.make({
      // Why: The hook runs as the subscriber who first polled, as a stream's runs as the one who
      // opened it; that poll's request scope is dropped, the lease's own scope holding the hook.
      lookup: (lease: Lease) =>
        Effect.provideContext(subscription(lease.input), Context.omit(Scope.Scope)(lease.context)),
      idleTimeToLive: ttl,
    }),
    (map) => ({
      hold: (key, input) =>
        Effect.flatMap(Effect.context<never>(), (context) =>
          Effect.scoped(RcMap.get(map, new Lease(key, input, context))),
        ),
    }),
  );
