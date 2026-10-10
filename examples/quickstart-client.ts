import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Http } from "./quickstart.js";

export const greeting = Effect.gen(function* () {
  const client = yield* ActionHttp.client(Http, { baseUrl: "http://127.0.0.1:3000" });

  return yield* client.greet({ name: "Ada" });
}).pipe(Effect.provide(FetchHttpClient.layer));
