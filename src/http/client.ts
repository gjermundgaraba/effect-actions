import { Effect, type Schema } from "effect";
import type { HttpClient, HttpClientError } from "effect/http";
import { type HttpApi, HttpApiClient } from "effect/http-api";
import type * as Action from "../contract/Action.js";
import type { Any as Authentication, VerifierError } from "../authentication/provider.js";
import { type Call, checked, type ErasedMethod } from "../contract/call.js";
import type { BuiltIns } from "../contract/errors.js";
import type { ErasedValue } from "../contract/implementation.js";

/**
 * The native `HttpApiClient.make` options except `transformResponse`: `baseUrl` and
 * `transformClient`. `transformResponse` may change a call's success, failure or
 * services, which the method types cannot follow.
 */
export type Options = Omit<
  NonNullable<Parameters<typeof HttpApiClient.make>[1]>,
  "transformResponse"
>;

type BindingError = Action.Errors[number];

/**
 * What one call of `A` fails with: a declared error value (the action's own, one `E` of the
 * binding's, or a built-in `InvalidInput`, `Unauthenticated` or `Forbidden`), a native
 * `HttpClientError` for a failed request or an undeclared answer, or a `SchemaError` when
 * the success does not decode. Input that does not encode is `InvalidInput`, and nothing is sent.
 */
export type MethodError<A extends Action.Any, E extends BindingError = never> =
  | A["error"][number]["Type"]
  | E["Type"]
  | BuiltIns["Type"]
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

type Method<A extends Action.Any, E extends BindingError> = Call<
  A,
  Effect.Effect<A["success"]["Type"], MethodError<A, E>>
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
 * with what its descriptor's verifier declares.
 */
export type Client<H extends AnyHttp> = {
  readonly [A in H["actions"][number] as A["name"]]: Method<
    A,
    H["error"][number] | VerifierError<A, H["authentication"]>
  >;
};

type NativeMethod = (request: {
  readonly payload: ErasedValue;
}) => Effect.Effect<ErasedValue, unknown>;

type NativeClient = { readonly [name: string]: NativeMethod | undefined };

export const methods = (
  http: AnyHttp,
  options: Options = {},
): Effect.Effect<{ readonly [name: string]: ErasedMethod }, never, HttpClient.HttpClient> =>
  Effect.map(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Native API boundary: every binding API is one top-level group whose endpoints take `{ payload }`; only the invariant static group map is dropped.
    HttpApiClient.make(http.api as HttpApi.HttpApi<string>, options),
    (client) => {
      const native: NativeClient = client;

      return Object.fromEntries(
        http.actions.map((action) => {
          const method = native[action.name];

          if (method === undefined) throw new Error(`No client method for ${action.name}`);

          return [action.name, checked(action, (payload) => method({ payload }))];
        }),
      );
    },
  );
