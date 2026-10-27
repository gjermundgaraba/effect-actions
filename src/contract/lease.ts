import { Context, Duration, Effect, Equal, Hash, RcMap, Scope } from "effect";

import type { ErasedValue } from "./implementation.js";

/** A poll subscription's key, held with the context of the poll that first acquired it. */
class Lease implements Equal.Equal {
  readonly key: string;
  readonly input: ErasedValue;
  readonly context: Context.Context<never>;

  constructor(
    key: string,
    input: ErasedValue,
    context: Context.Context<never>
  ) {
    this.key = key;
    this.input = input;
    this.context = context;
  }

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
  readonly hold: (key: string, input: ErasedValue) => Effect.Effect<void>;
  /** Releases `key`'s lease now, rather than `ttl` after its last poll. */
  readonly release: (key: string) => Effect.Effect<void>;
}

const defaultLease = Duration.minutes(5);

export const makeLeases = (
  subscription: (input: ErasedValue) => Effect.Effect<void, never, unknown>,
  ttl: Duration.Input = defaultLease
): Effect.Effect<Leases, never, unknown> =>
  Effect.map(
    RcMap.make({
      // Why: The hook runs as the subscriber who first polled, as a stream's runs as the one who
      // opened it; that poll's request scope is dropped, the lease's own scope holding the hook.
      lookup: (lease: Lease) =>
        Effect.provideContext(
          subscription(lease.input),
          Context.omit(Scope.Scope)(lease.context)
        ),
      idleTimeToLive: ttl,
    }),
    (map) => ({
      hold: (key, input) =>
        Effect.flatMap(Effect.context(), (context) =>
          Effect.scoped(RcMap.get(map, new Lease(key, input, context)))
        ),
      release: (key) =>
        RcMap.invalidate(map, new Lease(key, undefined, Context.empty())),
    })
  );
