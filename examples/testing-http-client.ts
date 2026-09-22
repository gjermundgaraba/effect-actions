import type { Effect } from "effect";
import type { HttpClient } from "effect/unstable/http";
import type { HttpApi, HttpApiClient, HttpApiGroup } from "effect/unstable/httpapi";
import * as Testing from "../src/Testing.js";

/** Native grouped client calling a web handler in memory; baseUrl defaults to http://localhost. */
export const httpClient: <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
  handler: Testing.Handler,
  options?: NonNullable<Parameters<typeof HttpApiClient.make>[1]>,
) => Effect.Effect<
  HttpApiClient.Client<Groups>,
  never,
  Exclude<HttpApiGroup.MiddlewareClient<Groups>, HttpClient.HttpClient>
> = Testing.httpClient;
