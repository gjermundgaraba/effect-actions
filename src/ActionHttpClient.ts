import type { Effect } from "effect";
import type { HttpClient } from "effect/unstable/http";
import {
  type AnyHttp,
  client,
  type Client,
  type ErasedMethod,
  type Options,
} from "./internal/client.js";

/** A client's methods, one per action of the binding. */
export type { Client } from "./internal/client.js";

/**
 * Effect's native `HttpApiClient` for a binding, one method per action taking the
 * action's input directly: `client.greet({ name })`. The argument may be omitted when `{}`
 * is a valid input. Requires the native `HttpClient`, as `HttpApiClient.make` does.
 * The options are the native ones, `baseUrl` and `transformClient`. The native client
 * itself stays available: `HttpApiClient.make(Http.api)`.
 *
 * A call fails with a declared error value (the action's own, or a built-in
 * `InvalidInput`, `Unauthenticated` or `Forbidden`), a native `HttpClientError` when the
 * server could not be reached or answered with a status or body the contract does not
 * declare, or a `SchemaError` when the input does not encode or the success does not
 * decode.
 */
export function make<const H extends AnyHttp>(
  http: H,
  options?: Options,
): Effect.Effect<Client<H>, never, HttpClient.HttpClient>;
export function make(
  http: AnyHttp,
  options?: Options,
): Effect.Effect<{ readonly [name: string]: ErasedMethod }, never, HttpClient.HttpClient> {
  return client(http, options);
}
