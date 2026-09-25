import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import * as ActionHttpClient from "../src/ActionHttpClient.js";
import { Http } from "./quickstart.js";

export const greeting = Effect.gen(function* () {
  const client = yield* ActionHttpClient.make(Http, { baseUrl: "http://127.0.0.1:3000" });

  return yield* client.greet({ name: "Ada" });
}).pipe(Effect.provide(FetchHttpClient.layer));
