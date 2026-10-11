import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Http } from "./Api.js";

// Entrypoint: `node --import tsx examples/quickstart/src/client.ts`, with the server running.
// One typed method per action of the binding.
Effect.gen(function* () {
  const client = yield* ActionHttp.client(Http, { baseUrl: "http://127.0.0.1:3000" });

  yield* Console.log(yield* client.greet({ name: "Ada" }));
}).pipe(Effect.provide(FetchHttpClient.layer), NodeRuntime.runMain);
