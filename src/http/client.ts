import { Effect, type Schema, Stream } from "effect";
import { HttpClient, type HttpClientError, HttpClientRequest } from "effect/http";
import { type HttpApi, HttpApiClient, type HttpApiSchema } from "effect/http-api";
import type * as Action from "../contract/Action.js";
import type { Any as Authentication, VerifierError } from "../authentication/provider.js";
import {
  type Call,
  checked,
  checkedStream,
  type ErasedMethod,
  type ErasedStreamMethod,
} from "../contract/call.js";
import type { BuiltIns } from "../contract/errors.js";
import type { ErasedValue } from "../contract/implementation.js";
import { readElements, readWithProgress } from "./streamed.js";
import { type Answer, elementOf, type StreamOf } from "../contract/stream.js";
import type { Codec } from "../contract/codec.js";

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

// Why: Named through the native client's stream, so the browser's client imports no encoding module.
type SseFailure = Extract<
  Stream.Error<
    HttpApiClient.SuccessType<
      HttpApiSchema.StreamSse<
        Extract<HttpApiSchema.StreamSchema, { readonly mode: "sse" }>["events"],
        typeof Schema.Never
      >
    >
  >,
  { readonly _tag: "SseError" | "Retry" }
>;

/**
 * What one call of `A` fails with: a declared error value (the action's own, one `E` of the
 * binding's, or a built-in `InvalidInput`, `Unauthenticated` or `Forbidden`), a native
 * `HttpClientError` for a failed request or an undeclared answer, or a `SchemaError` when
 * the success does not decode. A call reading an event stream, of an action answering a stream or
 * one given `onProgress`, also fails with Effect's `Sse.SseError` or `Sse.Retry`.
 */
export type MethodError<A extends Action.Any, E extends BindingError = never> =
  | A["error"][number]["Type"]
  | E["Type"]
  | BuiltIns["Type"]
  | HttpClientError.HttpClientError
  | Schema.SchemaError
  | (A["progress"] extends undefined
      ? A["success"] extends StreamOf<Codec>
        ? SseFailure
        : never
      : SseFailure);

type Method<A extends Action.Any, E extends BindingError, CE, CR> = Call<
  A,
  Answer<A["success"], MethodError<A, E> | CE, CR>
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

type NativeClient<M> = { readonly [name: string]: M | undefined };

/** A client's methods by name. */
export type Methods<R> = { readonly [name: string]: ErasedMethod<R> | ErasedStreamMethod<R> };

const methodOf = <M>(native: NativeClient<M>, name: string, what: string): M => {
  const method = native[name];

  if (method === undefined)
    throw new Error(
      `No client method for ${name} (use the binding \`ActionHttp.make\` returned, whose group holds this ${what})`,
    );

  return method;
};

const nativeOf = <E, R>(
  http: AnyHttp,
  httpClient: HttpClient.HttpClient.With<E, R>,
  baseUrl: Options["baseUrl"],
) =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Native API boundary: every binding API is one top-level group whose endpoints take `{ payload }`; only the invariant static group map is dropped.
  HttpApiClient.makeWith(http.api as HttpApi.HttpApi<string>, { baseUrl, httpClient });

const asksForStream = HttpClient.mapRequest(
  HttpClientRequest.setHeader("accept", "text/event-stream"),
);

/** Whether a call of `action` may read an event stream: its success streams, or it reports progress. */
const readsStream = (action: Action.Any) =>
  action.progress !== undefined || elementOf(action.success) !== undefined;

const nativesWith = <E, R>(
  http: AnyHttp,
  httpClient: HttpClient.HttpClient.With<E, R>,
  baseUrl: Options["baseUrl"],
) =>
  Effect.gen(function* () {
    const client = yield* nativeOf(http, httpClient, baseUrl);

    const streaming = !http.actions.some(readsStream)
      ? {}
      : yield* nativeOf(http, asksForStream(httpClient), baseUrl);

    return { client, streaming };
  });

const actionMethodOf = <R>(
  action: Action.Any,
  native: NativeClient<NativeMethod<R>>,
  nativeStreamed: NativeClient<NativeMethod<R>>,
): ErasedMethod<R> | ErasedStreamMethod<R> => {
  const method = methodOf(native, action.name, "action");

  if (elementOf(action.success) !== undefined)
    return checkedStream(action, (payload, onProgress) =>
      Stream.unwrap(
        Effect.map(methodOf(nativeStreamed, action.name, "action")({ payload }), (answer) =>
          readElements(answer, onProgress),
        ),
      ),
    );

  if (action.progress === undefined) return checked(action, (payload) => method({ payload }));

  const streamed = methodOf(nativeStreamed, action.name, "action");

  return checked(action, (payload, onProgress) =>
    onProgress === undefined
      ? method({ payload })
      : Effect.flatMap(streamed({ payload }), (answer) => readWithProgress(answer, onProgress)),
  );
};

const actionsOf = <R>(
  http: AnyHttp,
  native: NativeClient<NativeMethod<R>>,
  nativeStreamed: NativeClient<NativeMethod<R>>,
): Methods<R> =>
  Object.fromEntries(
    http.actions.map((action) => [action.name, actionMethodOf(action, native, nativeStreamed)]),
  );

const methodsWith = <E, R>(
  http: AnyHttp,
  httpClient: HttpClient.HttpClient.With<E, R>,
  baseUrl: Options["baseUrl"],
): Effect.Effect<Methods<R>> =>
  Effect.map(nativesWith(http, httpClient, baseUrl), ({ client, streaming }) =>
    actionsOf<R>(http, client, streaming),
  );

export const methods = <E, R>(
  http: AnyHttp,
  { baseUrl, transformClient }: Options<E, R> = {},
): Effect.Effect<Methods<R>, never, HttpClient.HttpClient> =>
  Effect.flatMap(HttpClient.HttpClient, (native) =>
    transformClient === undefined
      ? methodsWith(http, native, baseUrl)
      : methodsWith(http, transformClient(native), baseUrl),
  );
