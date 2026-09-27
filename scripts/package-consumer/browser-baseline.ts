// `browser.ts` with Effect's own `HttpApi` and no effect-actions: what the package's
// cost in a browser bundle is measured against.
import { Effect, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { HttpApi, HttpApiClient, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

const Api = HttpApi.make("api").add(
  HttpApiGroup.make("api", { topLevel: true }).add(
    HttpApiEndpoint.post("greet", "/api/greet", {
      payload: Schema.Struct({ name: Schema.String }),
      success: Schema.String,
    }),
  ),
);

export const greet = (name: string) =>
  Effect.flatMap(HttpApiClient.make(Api), (client) => client.greet({ payload: { name } })).pipe(
    Effect.provide(FetchHttpClient.layer),
  );
