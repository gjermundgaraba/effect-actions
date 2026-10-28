import { Buffer } from "node:buffer";

import { NodeRuntime } from "@effect/platform-node";
import * as ActionHttp from "@gjermundgaraba/effect-actions/ActionHttp";
import { Config, Console, Effect, flow } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { Http } from "./Api.js";

const screenshot = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

const seed = Effect.gen(function* () {
  const baseUrl = yield* Config.String("TRACKER_URL").pipe(
    Config.withDefault("http://127.0.0.1:3000")
  );

  const tracker = yield* ActionHttp.client(Http, {
    baseUrl,
    transformClient: HttpClient.mapRequest(
      flow(
        HttpClientRequest.bearerToken("ada"),
        HttpClientRequest.setHeader("x-workspace", "acme")
      )
    ),
  });

  const issue = yield* tracker.createIssue({
    title: "Crash on save",
    body: "Saving an empty draft crashes the editor.",
  });

  const attachment = yield* tracker.attachImage({
    issue: issue.id,
    name: "crash.png",
    image: { data: screenshot, mimeType: "image/png" },
  });

  yield* tracker.commentOnIssue({ id: issue.id, text: "Reproduced on 2.4.1." });

  const { issues } = yield* tracker.listIssues();

  yield* Console.log(
    `Filed ${issue.id} with attachment ${attachment.id}. Issues:`,
    issues
  );
}).pipe(
  Effect.catchTags({
    RateLimited: ({ retryAfterSeconds }) =>
      Console.error(`Write limit reached: retry in ${retryAfterSeconds}s.`),
    QuotaExceeded: ({ retryAfterSeconds }) =>
      Console.error(`Request quota spent: retry in ${retryAfterSeconds}s.`),
    IssuerUnavailable: () =>
      Console.error("The sign-in service is down: try again later."),
  })
);

seed.pipe(Effect.provide(FetchHttpClient.layer), NodeRuntime.runMain());
