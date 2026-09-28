import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import * as ActionHttp from "../src/ActionHttp.js";
import { Http } from "./binding.js";

// Built once, for code that does not run Effects: its methods need nothing more.
export const api = ActionHttp.client(Http).pipe(
  Effect.provide(FetchHttpClient.layer),
  // `fetch` is read on every call, so a wrapper or a test's stub installed later is used.
  Effect.provideService(FetchHttpClient.Fetch, (input, init) => globalThis.fetch(input, init)),
  Effect.runSync,
);

// A promise per call. A declared error rejects it as its decoded value, so
// `error instanceof UserNotFound` holds in a `catch`.
export const userName = async (id: string): Promise<string> =>
  (await Effect.runPromise(api.getUser({ id }))).name;
