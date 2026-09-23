import { Effect } from "effect";
import type * as Action from "./Action.js";
import type * as ActionHttp from "./ActionHttp.js";
import type { Actions } from "./internal/actions.js";
import { type ClientOptions, fetchApiClient } from "./internal/fetchClient.js";
import type { ErasedValue } from "./internal/implementation.js";

/**
 * The native `HttpApiClient.make` options except `transformResponse`, plus `fetch`;
 * see the options table in docs/ActionHttpClient.md.
 */
export interface Options extends Omit<ClientOptions, "transformResponse"> {
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * One action as a Promise of its decoded success. An action whose input may be empty,
 * such as one declared without `input`, may be called without an argument.
 */
export type Method<A extends Action.Any> = {} extends A["input"]["Type"]
  ? (input?: A["input"]["Type"]) => Promise<A["success"]["Type"]>
  : (input: A["input"]["Type"]) => Promise<A["success"]["Type"]>;

/** Every action of the binding, as `client.<group>.<action>(input)`. */
export type Client<Groups extends ReadonlyArray<Actions>> = {
  readonly [G in Groups[number] as [G["actions"][number]] extends [never] ? never : G["name"]]: {
    readonly [A in G["actions"][number] as A["name"]]: Method<A>;
  };
};

/** A method with its action erased; `promise`'s public signature restores it. */
type ErasedMethod = (input?: ErasedValue) => Promise<ErasedValue>;

/**
 * A Promise client for an HTTP binding, for code that does not run Effects, such as a
 * browser page. It is Effect's native `HttpApiClient` over `fetch`, built once, and
 * each call runs one request: nothing is retried.
 *
 * A call resolves with the action's decoded success. It rejects with what the native
 * client fails with: a declared error value (the action's, its group's schema-error
 * policy's, or the binding's surface `errors`), a native `HttpClientError` when the
 * server could not be reached or answered with a status or body the contract does not
 * declare, or a `SchemaError` when the input does not encode or the success does not
 * decode.
 */
export function promise<
  const Groups extends ReadonlyArray<Actions>,
  const Errors extends ReadonlyArray<Action.Codec>,
>(http: ActionHttp.Http<Groups, Errors>, options?: Options): Client<Groups>;
export function promise(
  http: ActionHttp.Http<ReadonlyArray<Actions>, ReadonlyArray<Action.Codec>>,
  { baseUrl, transformClient, fetch }: Options = {},
): Readonly<Record<string, Readonly<Record<string, ErasedMethod>>>> {
  // Late binding keeps a stubbed or replaced global `fetch` authoritative.
  const send: typeof globalThis.fetch = fetch ?? ((input, init) => globalThis.fetch(input, init));

  // Building the client is construction, not a request, so it runs synchronously.
  const native = Effect.runSync(fetchApiClient(http.api, send, { baseUrl, transformClient }));

  // The native client has one namespace per group with actions, one method per action.
  return Object.fromEntries(
    Object.entries(native).map(([group, endpoints]) => [
      group,
      Object.fromEntries(
        Object.entries(endpoints).map(([action, endpoint]) => {
          // An omitted or `undefined` input is the empty input `Method` makes optional.
          const method: ErasedMethod = (input) =>
            Effect.runPromise(endpoint({ payload: input ?? {} }));

          return [action, method] as const;
        }),
      ),
    ]),
  );
}
