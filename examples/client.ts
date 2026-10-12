import { Console, Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Http } from "./binding.js";

const lookup = Effect.gen(function* () {
  const client = yield* ActionHttp.client(Http, {
    baseUrl: "http://127.0.0.1:3000",
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken("alice")),
  });

  const status = yield* client.status();
  const user = yield* client.getUser({ id: "1" });
  const identity = yield* client.whoAmI();

  return { status, user, identity };
});

// Every endpoint declares the built-in refusals, so the 401 the authentication
// renders arrives as a typed `Unauthenticated`, not a decode error.
const refused = Effect.gen(function* () {
  const client = yield* ActionHttp.client(Http, { baseUrl: "http://127.0.0.1:3000" });

  return yield* Effect.flip(client.whoAmI());
});

await Effect.runPromise(
  Effect.all([lookup, refused]).pipe(
    Effect.tap(Console.log),
    Effect.provide(FetchHttpClient.layer),
  ),
);
