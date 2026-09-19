import { HttpApiClient } from "effect/unstable/httpapi";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Http } from "./quickstart.js";

export const greeting = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(Http.api, { baseUrl: "http://127.0.0.1:3000" });

  return yield* client.greetings.greet({ payload: { name: "Ada" } });
}).pipe(Effect.provide(FetchHttpClient.layer));
