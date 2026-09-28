import { Effect, type Schema } from "effect";
import type { HttpClient, HttpClientError } from "effect/http";
import { type HttpApi, HttpApiClient } from "effect/http-api";
import type * as Action from "../Action.js";
import type { BuiltIns } from "./errors.js";
import type { ErasedValue } from "./implementation.js";

/**
 * The native `HttpApiClient.make` options except `transformResponse`: `baseUrl` and
 * `transformClient`. `transformResponse` may change a call's success, failure or
 * services, which the method types cannot follow.
 */
export type Options = Omit<
  NonNullable<Parameters<typeof HttpApiClient.make>[1]>,
  "transformResponse"
>;

/**
 * A call of `A` answering `R`. It may leave its input out when `{}` is a valid input, such
 * as for an action declared without `input`, and then sends `{}`. The client and
 * `Testing.mcpClient` share this rule.
 */
export type Call<A extends Action.Any, R> = {} extends A["input"]["Type"]
  ? (...input: [] | [input: A["input"]["Type"]]) => R
  : (input: A["input"]["Type"]) => R;

/** An error schema the binding declares on every endpoint. */
type BindingError = Action.Any["errors"][number];

/**
 * What one call of `A` fails with: a declared error value (the action's own, one `E` of the
 * binding's, or a built-in `InvalidInput`, `Unauthenticated` or `Forbidden`), a native
 * `HttpClientError` for a failed request or an undeclared answer, or a `SchemaError` when
 * the input does not encode or the success does not decode.
 */
export type MethodError<A extends Action.Any, E extends BindingError = never> =
  | A["errors"][number]["Type"]
  | E["Type"]
  | BuiltIns["Type"]
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

/** One action as an Effect of its decoded success, failing with `MethodError`. */
type Method<A extends Action.Any, E extends BindingError> = Call<
  A,
  Effect.Effect<A["success"]["Type"], MethodError<A, E>>
>;

/**
 * Any HTTP binding. The API is a native constraint here because native groups are
 * invariant in their endpoints; `actions` carries the types.
 */
export interface AnyHttp {
  readonly actions: ReadonlyArray<Action.Any>;
  readonly errors: ReadonlyArray<BindingError>;
  readonly api: HttpApi.Constraint;
}

/** Every action of the binding `H`, as `client.<action>(input)`. */
export type Client<H extends AnyHttp> = {
  readonly [A in H["actions"][number] as A["name"]]: Method<A, H["errors"][number]>;
};

/** A client method, erased: the binding's actions restore its exact type. */
export type ErasedMethod = (
  ...input: ReadonlyArray<ErasedValue>
) => Effect.Effect<ErasedValue, unknown>;

/** A native client method, erased. */
type NativeMethod = (request: {
  readonly payload: ErasedValue;
}) => Effect.Effect<ErasedValue, unknown>;

/** A native client, erased: one method per endpoint of the top-level group. */
type NativeClient = { readonly [name: string]: NativeMethod | undefined };

/**
 * Build the native client of a binding once and look up each action's method, taking the
 * action's input directly. Every binding API is a native `HttpApi` of one top-level
 * group built from `http.actions`, so each action has a native method of its name.
 */
export const methods = (
  http: AnyHttp,
  options: Options = {},
): Effect.Effect<(action: Action.Any) => ErasedMethod, never, HttpClient.HttpClient> =>
  Effect.map(
    // SAFETY: every binding API is one top-level group whose endpoints take `{ payload }`;
    // only the invariant static group map is dropped.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Native API boundary.
    HttpApiClient.make(http.api as HttpApi.HttpApi<string>, options),
    (client) => {
      const native: NativeClient = client;

      return (action) => {
        const method = native[action.name];

        if (method === undefined) throw new Error(`No client method for ${action.name}`);

        // `Call` allows no argument only when `{}` is a valid input; a given argument is
        // sent as given.
        return (...input) => method({ payload: input.length === 0 ? {} : input[0] });
      };
    },
  );
