import { Effect, type Schema } from "effect";
import { HttpClient, type HttpClientError } from "effect/http";
import { type HttpApi, HttpApiClient } from "effect/http-api";
import type * as Action from "../contract/Action.js";
import type { Any as Authentication, VerifierError } from "../authentication/provider.js";
import { type Call, checked, type ErasedMethod } from "../contract/call.js";
import type { BuiltIns } from "../contract/errors.js";
import type { ErasedValue } from "../contract/implementation.js";

/**
 * The native `HttpApiClient.make` options except `transformResponse`, which may change a call's
 * success, failure or services the method types cannot follow: `baseUrl`, and `transformClient`,
 * which may return a client failing with `E` or requiring `R` of its own, as
 * `HttpApiClient.makeWith` takes one.
 */
export interface Options<E = HttpClientError.HttpClientError, R = never> {
  /**
   * What the routes resolve against: `https://api.example.com`. Omitted: relative routes, which
   * a page resolves against its own origin.
   *
   * **Gotchas**
   *
   * - Outside a browser, set it: a relative route has no page to resolve against, and the call fails with an `HttpClientError` whose `reason._tag` is `InvalidUrlError`.
   */
  readonly baseUrl?: NonNullable<Parameters<typeof HttpApiClient.make>[1]>["baseUrl"];
  /**
   * Wraps the native `HttpClient` the calls send with: a bearer token is
   * `HttpClient.mapRequest(HttpClientRequest.bearerToken(token))`, and a credential read or
   * refreshed as each request is sent `(client) => HttpClient.mapRequestEffect(client, authorize)`.
   * A method also fails with what the returned client fails with beyond an `HttpClientError`, as
   * it is, and requires what it requires.
   */
  readonly transformClient?:
    | ((client: HttpClient.HttpClient) => HttpClient.HttpClient.With<E, R>)
    | undefined;
}

type BindingError = Action.Errors[number];

/**
 * What one call of `A` fails with: a declared error value (the action's own, one `E` of the
 * binding's, or a built-in `InvalidInput`, `Unauthenticated` or `Forbidden`), a native
 * `HttpClientError` for a failed request or an undeclared answer, or a `SchemaError` when
 * the success does not decode.
 */
export type MethodError<A extends Action.Any, E extends BindingError = never> =
  | A["error"][number]["Type"]
  | E["Type"]
  | BuiltIns["Type"]
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

type Method<A extends Action.Any, E extends BindingError, CE, CR> = Call<
  A,
  Effect.Effect<A["success"]["Type"], MethodError<A, E> | CE, CR>
>;

/**
 * Any HTTP binding, with its actions erased: what `layer` and `client` read. The API is a native
 * constraint here because native groups are invariant in their endpoints; `actions` carries the
 * types.
 */
export interface AnyHttp {
  readonly authentication?: Authentication | undefined;
  readonly actions: ReadonlyArray<Action.Any>;
  readonly error: ReadonlyArray<BindingError>;
  readonly prefix: `/${string}`;
  readonly api: HttpApi.Constraint;
}

/**
 * Every action of the binding `H`, as `client.<action>(input)`: a protected one may also fail
 * with what its descriptor's verifier declares. Each call also fails with `E` and requires `R`,
 * what its `transformClient` adds.
 */
export type Client<H extends AnyHttp, E = never, R = never> = {
  readonly [A in H["actions"][number] as A["name"]]: Method<
    A,
    H["error"][number] | VerifierError<A, H["authentication"]>,
    E,
    R
  >;
};

type NativeMethod<R> = (request: {
  readonly payload: ErasedValue;
}) => Effect.Effect<ErasedValue, unknown, R>;

type NativeClient<R> = { readonly [name: string]: NativeMethod<R> | undefined };

const methodsWith = <E, R>(
  http: AnyHttp,
  httpClient: HttpClient.HttpClient.With<E, R>,
  baseUrl: Options["baseUrl"],
): Effect.Effect<{ readonly [name: string]: ErasedMethod<R> }> =>
  Effect.map(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Native API boundary: every binding API is one top-level group whose endpoints take `{ payload }`; only the invariant static group map is dropped.
    HttpApiClient.makeWith(http.api as HttpApi.HttpApi<string>, { baseUrl, httpClient }),
    (client) => {
      const native: NativeClient<R> = client;

      return Object.fromEntries(
        http.actions.map((action) => {
          const method = native[action.name];

          if (method === undefined)
            throw new Error(
              `No client method for ${action.name} (use the binding \`ActionHttp.make\` returned, whose group holds this action)`,
            );

          return [action.name, checked(action, (payload) => method({ payload }))];
        }),
      );
    },
  );

export const methods = <E, R>(
  http: AnyHttp,
  { baseUrl, transformClient }: Options<E, R> = {},
): Effect.Effect<{ readonly [name: string]: ErasedMethod<R> }, never, HttpClient.HttpClient> =>
  Effect.flatMap(HttpClient.HttpClient, (native) =>
    transformClient === undefined
      ? methodsWith(http, native, baseUrl)
      : methodsWith(http, transformClient(native), baseUrl),
  );
