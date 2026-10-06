import { Context, type Effect, type Schema, type Scope } from "effect";
import type * as Action from "../Action.js";

type Codec = Schema.Codec<unknown, unknown, never, never>;

export type ServiceOf<K> = K extends Context.Key<infer I, unknown> ? I : never;

export type CheckCallback<E, R> = (action: Action.Any) => Effect.Effect<void, E, R>;

/** The request services a check reads: one key, or several. */
type Requires = Context.Key<unknown, unknown> | ReadonlyArray<Context.Key<unknown, unknown>>;

/** A transport-free operational check declaration, implemented once with a native layer. */
export interface AnyCheck extends Context.Key<unknown, CheckCallback<unknown, unknown>> {
  readonly error: Codec;
  readonly requires?: Requires;
}

export interface CheckOptions {
  readonly error: Codec;
  readonly requires?: Requires;
}

/** The services a check's `requires` names, each key's or every listed key's. */
type ServicesOf<K> = K extends ReadonlyArray<infer Each> ? ServiceOf<Each> : ServiceOf<K>;

type RequiredBy<O> = O extends { readonly requires: infer K } ? ServicesOf<K> : never;

export const Check =
  <Self>() =>
  <const Name extends string, const O extends CheckOptions>(
    name: Name,
    options: O,
  ): Context.ServiceClass<Self, Name, CheckCallback<O["error"]["Type"], Within<O>>> & O =>
    Object.assign(
      Context.Service<Self, CheckCallback<O["error"]["Type"], Within<O>>>()(name),
      options,
    );

/**
 * What a check's callback may read: its declared request services, and the call's own
 * `Scope`, closed when the call ends, so a caller owes no `Scope` for it.
 */
type Within<O> = RequiredBy<O> | Scope.Scope;

export type CheckServices<A extends Action.Any> = ServiceOf<A["checks"][number]>;

export type CheckRequests<A extends Action.Any> = A["checks"][number] extends infer C
  ? C extends { readonly requires: infer K }
    ? ServicesOf<K>
    : never
  : never;
