import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { ActionHttp } from "../src/index.js";
import { Actions } from "./quickstart.js";

export const greeting = Effect.gen(function* () {
  const client = yield* ActionHttp.client(Actions, {
    apiPath: "/api/actions",
    baseUrl: "http://127.0.0.1:3000",
  });

  return yield* client.greet({ name: "Ada" });
}).pipe(Effect.provide(FetchHttpClient.layer));
