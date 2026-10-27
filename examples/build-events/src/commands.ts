import * as ActionCli from "@gjermundgaraba/effect-actions/ActionCli";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Config, Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { Http } from "./Api.js";

// The binding's client, connected to where the server is and as which member, both read from
// config when a command runs.
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

// A command per action, and `watch <event>` per event type: `builds watch build.finished
// --pipeline api` holds the event's stream open and prints each occurrence as a line of JSON,
// its `cursor` included, until it is stopped. `--cursor <cursor>` resumes after that line;
// omitted, the watch starts from now. The lines pipe into `jq` or a script as they come.
// `builds start-build --pipeline api` prints each step as a line of JSON on stderr as it
// starts, and the build on stdout, which a pipe reads alone. `builds tail-log --build-id
// build-1` prints each line of its log as a line of JSON as it arrives.
export const commands = ActionCli.remote(Http, { name: "builds", client: api });
