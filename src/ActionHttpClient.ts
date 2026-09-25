import { Effect } from "effect";
import type { HttpClient } from "effect/unstable/http";
import type * as Action from "./Action.js";
import {
  type AnyHttp,
  type Call,
  client,
  type Client,
  type ErasedMethod,
  type ErrorsOf,
  type Options,
  withFetch,
} from "./internal/client.js";
import type { ErasedValue } from "./internal/implementation.js";

/** A client's methods, one per action of the binding. */
export type { AnyHttp, Client, ErrorsOf, Method, Options } from "./internal/client.js";

/** `Options`, plus the `fetch` the Promise client sends through. */
export interface PromiseOptions extends Options {
  readonly fetch?: typeof globalThis.fetch;
}

/** One action as a Promise of its decoded success. */
export type PromiseMethod<A extends Action.Any> = Call<A, Promise<A["success"]["Type"]>>;

/** Every action of `Actions`, as `client.<action>(input)`. */
export type PromiseClient<Actions extends ReadonlyArray<Action.Any>> = {
  readonly [A in Actions[number] as A["name"]]: PromiseMethod<A>;
};

/**
 * Effect's native `HttpApiClient` for a binding, one method per action taking the
 * action's input directly: `client.greet({ name })`. The argument may be omitted when `{}`
 * is a valid input. Requires the native `HttpClient`, as `HttpApiClient.make` does.
 * The native client itself stays available: `HttpApiClient.make(Http.api)`.
 */
export function make<const H extends AnyHttp>(
  http: H,
  options?: Options,
): Effect.Effect<Client<H["actions"], ErrorsOf<H>>, never, HttpClient.HttpClient>;
export function make(
  http: AnyHttp,
  options?: Options,
): Effect.Effect<{ readonly [name: string]: ErasedMethod }, never, HttpClient.HttpClient> {
  return client(http, options);
}

/**
 * A Promise client for an HTTP binding, for code that does not run Effects, such as a
 * browser page: `make` over `fetch`, built once, and each call runs one request. Nothing
 * is retried.
 *
 * A call resolves with the action's decoded success. It rejects with what `make`'s
 * method fails with: a declared error value (the action's, or the binding's surface or
 * schema-error policy errors), a native `HttpClientError` when the server could not be
 * reached or answered with a status or body the contract does not declare, or a
 * `SchemaError` when the input does not encode or the success does not decode.
 */
export function promise<const H extends AnyHttp>(
  http: H,
  options?: PromiseOptions,
): PromiseClient<H["actions"]>;
export function promise(
  http: AnyHttp,
  { fetch, ...options }: PromiseOptions = {},
): { readonly [name: string]: (...input: ReadonlyArray<ErasedValue>) => Promise<ErasedValue> } {
  // Late binding keeps a stubbed or replaced global `fetch` authoritative.
  const send: typeof globalThis.fetch = fetch ?? ((input, init) => globalThis.fetch(input, init));

  // Building the client is construction, not a request, so it runs synchronously.
  const methods = Effect.runSync(client(http, options).pipe(withFetch(send)));

  return Object.fromEntries(
    Object.entries(methods).map(([name, method]) => [
      name,
      (...input: ReadonlyArray<ErasedValue>) => Effect.runPromise(method(...input)),
    ]),
  );
}
