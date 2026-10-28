import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Config, Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { Http } from "./Api.js";

const api = Effect.gen(function* () {
  const baseUrl = yield* Config.String("BUILDS_URL").pipe(
    Config.withDefault("http://127.0.0.1:3000")
  );

  const token = yield* Config.Redacted("BUILDS_TOKEN");

  return yield* ActionHttp.client(Http, {
    baseUrl,
    transformClient: HttpClient.mapRequest(
      HttpClientRequest.bearerToken(token)
    ),
  });
});

export const commands = ActionCli.remote(Http, { name: "builds", client: api });
