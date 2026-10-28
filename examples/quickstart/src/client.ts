import { NodeRuntime } from "@effect/platform-node";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Console, Effect } from "effect";
import { FetchHttpClient } from "effect/http";

import { Http } from "./Api.js";

Effect.gen(function* () {
  const client = yield* ActionHttp.client(Http, {
    baseUrl: "http://127.0.0.1:3000",
  });

  yield* Console.log(yield* client.greet({ name: "Ada" }));
}).pipe(Effect.provide(FetchHttpClient.layer), NodeRuntime.runMain());
