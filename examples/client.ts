import { Console, Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { Http } from "./contracts.js";

const lookup = Effect.gen(function* () {
  const client = yield* Http.client({
    baseUrl: "http://127.0.0.1:3000",
    transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken("alice")),
  });

  const user = yield* client.getUser({ id: "1" });
  const identity = yield* client.whoAmI();

  return { user, identity };
});

await Effect.runPromise(
  lookup.pipe(Effect.tap(Console.log), Effect.provide(FetchHttpClient.layer)),
);
