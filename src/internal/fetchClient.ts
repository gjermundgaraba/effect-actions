import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { type HttpApi, HttpApiClient, type HttpApiGroup } from "effect/unstable/httpapi";

/** The native `HttpApiClient.make` options: `baseUrl`, `transformClient`, `transformResponse`. */
export type ClientOptions = NonNullable<Parameters<typeof HttpApiClient.make>[1]>;

/** The native grouped `HttpApiClient` of `api`, sending every request through `fetch`. */
export const fetchApiClient = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
  fetch: typeof globalThis.fetch,
  options?: ClientOptions,
) =>
  HttpApiClient.make(api, options).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );
