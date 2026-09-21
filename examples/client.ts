import { HttpApiClient } from "effect/unstable/httpapi";
import { Console, Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { Http } from "./contracts.js";

const lookup = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(Http.api, {
    baseUrl: "http://127.0.0.1:3000",
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken("alice")),
  });

  const status = yield* client.public.status({ payload: {} });
  const user = yield* client.users.getUser({ payload: { id: "1" } });
  const identity = yield* client.users.whoAmI({ payload: {} });

  return { status, user, identity };
});

// `Http` declares the surface's own failures, so the 401 the authentication
// middleware renders arrives as a typed `Unauthenticated`, not a decode error.
const refused = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(Http.api, { baseUrl: "http://127.0.0.1:3000" });

  return yield* Effect.flip(client.users.whoAmI({ payload: {} }));
});

await Effect.runPromise(
  Effect.all([lookup, refused]).pipe(
    Effect.tap(Console.log),
    Effect.provide(FetchHttpClient.layer),
  ),
);
